'use strict';

const dgram = require('dgram');
const Buffer = require('buffer').Buffer;
const urlParse = require('url').parse;
const crypto = require('crypto')

const torrentParser = require('./torrent-parser');
const util = require('./util');
const { setTimeout } = require('timers/promises');

module.exports.getPeers = (torrent, callback) => {
  const socket = dgram.createSocket('udp4');
  const url = torrent.announce.toString('utf-8');
  //1. Send conect request
  udpSend(socket, buildConnReq(), url);

  socket.on('message', response => {
    if (respType(response) === 'connect') {
      // 2. receive/parse connect response
      const connResp = parseConnResp(response);
      // 3. send announce request
      const announceReq = buildAnnounceReq(connResp.connectionId, torrent);
      udpSend(socket, announceReq, url);
    } else if (respType(response) === 'announce') {
      // 4. parse announce response
      const announceResp = parseAnnounceResp(response);
      // 5. pass peers to callback
      callback(announceResp.peers);
    }
  });

};

function udpSend(socket, message, rawUrl, callback=()=>{}) {
  const url = urlParse(rawUrl);
  socket.send(message, 0, message.length, url.port, url.host, callback);
};

function respType(resp) {
  const action = resp.readUInt32BE(0);
  if (action === 0) return "connect";
  if (action === 1) return "announce";
};

function buildConnReq() {
  const buf = Buffer.alloc(16);

  buf.writeUint32BE(0x417, 0);
  buf.writeUint32BE(0x27101980, 4);
  buf.writeUInt32BE(0, 8);
  crypto.randomBytes(4).copy(buf, 12);

  return buf;
};

function parseConnResp(resp) {
  return {
    action: resp.readUInt32BE(0),
    transactionId: resp.readUInt32BE(4),
    connectionId: resp.slice(8)
  }
};

function buildAnnounceReq(connId, torrent, port=6881) {
  const buf = Buffer.allocUnsafe(98);
  // connection id
  connId.copy(buf, 0);
  // action
  buf.writeUInt32BE(1, 8);
  // transaction id
  crypto.randomBytes(4).copy(buf, 12);
  // info hash
  torrentParser.infoHash(torrent).copy(buf, 16);
  // peerId
  util.genId().copy(buf, 36);
  // downloaded
  Buffer.alloc(8).copy(buf, 56);
  //left
  torrentParser.size(torrent).copy(buf, 64);
  // uploaded
  Buffer.alloc(8).copy(buf, 72);
  // event
  buf.writeUInt32BE(0, 80);
  // ip address
  buf.writeUInt32BE(0, 80);
  // key
  crypto.randomBytes(4).copy(buf, 88);
  // num want
  buf.writeInt32BE(-1, 92);
  // port
  buf.writeUInt16BE(port, 96);

  return buf;
};

function parseAnnounceResp(resp) {
  function group(iterable, groupSize=1) {
    let groups = [];
    for (let i=0; i < iterable.length; i += groupSize) {
      groups.push(iterable.slice(i, i + groupSize));
    }
    return groups;
  }

  return {
    action: resp.readUInt32BE(0),
    transactionId: resp.readUInt32BE(4),
    leechers: resp.readUInt32BE(8),
    seeders: resp.readUInt32BE(12),
    peers: group(resp.slice(20), 6).map(address => {
      return {
        ip: address.slice(0, 4).join('.'),
        port: address.readUInt64BE(4)
      }
    })
  }
};

// TODO: retry
// params: socket, timeout (initial is 0)
// sets a timeout for n seconds, after which function will re-call with a larger timeout
// spec for bittorrent says timeout is 2^n * 15 seconds, with n maxing out at 8.
function udpSendWithRetry(socket, message, rawUrl, numRetries, callback=()=>{}) {
  if (numRetries >= 8) {
    udpSend(socket, message, rawUrl, callback);
  } else {
    // this feels real messy, TODO: clean up
    const retrySeconds = (numRetries**2) * 15000;
    const retryTimeout = setTimeout(() => udpSendWithRetry(socket, message, rawUrl, numRetries+1, callback), retrySeconds);
    const callbackAndClear = () => {
      callback();
      clearTimeout(retryTimeout);
    }
    udpSend(socket, message, rawUrl, callbackAndClear);
  }
}

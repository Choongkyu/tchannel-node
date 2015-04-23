// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var assert = require('assert');
var globalTimers = {
    setTimeout: require('timers').setTimeout,
    clearTimeout: require('timers').clearTimeout,
    now: Date.now
};
var globalRandom = Math.random;
var net = require('net');
var format = require('util').format;
var extend = require('xtend');

var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var nullLogger = require('./null-logger.js');
var EndpointHandler = require('./endpoint-handler.js');
var TChannelRequest = require('./request');
var TChannelServiceNameHandler = require('./service-name-handler');
var errors = require('./errors');

var TChannelConnection = require('./connection');
var TChannelPeers = require('./peers');

var TracingAgent = require('./trace/agent');

// TODO restore spying
// var Spy = require('./v2/spy');
// var dumpEnabled = /\btchannel_dump\b/.test(process.env.NODE_DEBUG || '');

function TChannel(options) {
    if (!(this instanceof TChannel)) {
        return new TChannel(options);
    }

    var self = this;
    EventEmitter.call(self);

    self.options = extend({
        timeoutCheckInterval: 1000,
        timeoutFuzz: 100,
        // TODO: maybe we should always add pid to user-supplied?
        processName: format('%s[%s]', process.title, process.pid)
    }, options);

    self.requestDefaults = extend({
        timeout: TChannelRequest.defaultTimeout
    }, self.options.requestDefaults);

    self.logger = self.options.logger || nullLogger;
    self.random = self.options.random || globalRandom;
    self.timers = self.options.timers || globalTimers;

    // Filled in by the listen call:
    self.host = null;
    self.requestedPort = null;

    // Filled in by listening event:
    self.hostPort = null;

    // name of the service running over this channel
    self.serviceName = '';
    if (self.options.serviceName) {
        self.serviceName = self.options.serviceName;
        delete self.options.serviceName;
    }

    // populated by makeSubChannel
    self.topChannel = null;
    self.subChannels = self.serviceName ? null : {};

    // how to handle incoming requests
    if (!self.options.handler) {
        if (!self.serviceName) {
            self.handler = TChannelServiceNameHandler(self);
        } else {
            self.handler = EndpointHandler(self.serviceName);
        }
    } else {
        self.handler = self.options.handler;
        delete self.options.handler;
    }

    // populated by:
    // - manually api (.peers.add etc)
    // - incoming connections on any listening socket
    self.peers = TChannelPeers(self, self.options);

    // TChannel advances through the following states.
    self.listened = false;
    self.listening = false;
    self.destroyed = false;

    if (self.options.trace) {
        self.tracer = new TracingAgent({
            logger: self.logger,
            forceTrace: self.options.forceTrace,
            serviceName: self.options.tracingServiceName,
            reporter: self.options.traceReporter
        });

        if (self.requestDefaults.trace !== false) {
            self.requestDefaults.trace = true;
        }
    }

    // lazily created by .getServer (usually from .listen)
    self.serverSocket = null;
    self.serverConnections = null;
}
inherits(TChannel, EventEmitter);

TChannel.prototype.getServer = function getServer() {
    var self = this;
    if (self.serverSocket) {
        return self.serverSocket;
    }

    self.serverConnections = Object.create(null);
    self.serverSocket = net.createServer(onServerSocketConnection);
    self.serverSocket.on('listening', onServerSocketListening);
    self.serverSocket.on('error', onServerSocketError);

    return self.serverSocket;

    function onServerSocketConnection(sock) {
        self.onServerSocketConnection(sock);
    }

    function onServerSocketListening() {
        self.onServerSocketListening();
    }

    function onServerSocketError(err) {
        self.onServerSocketError(err);
    }
};

TChannel.prototype.onServerSocketConnection = function onServerSocketConnection(sock) {
    var self = this;

    if (self.destroyed) {
        self.logger.error('got incoming socket whilst destroyed', {
            remoteAddr: sock.remoteAddr,
            remotePort: sock.remotePort,
            hostPort: self.hostPort
        });
        return;
    }

    var remoteAddr = sock.remoteAddress + ':' + sock.remotePort;
    var conn = new TChannelConnection(self, sock, 'in', remoteAddr);

    conn.on('span', function handleSpanFromConn(span) {
        self.tracer.report(span);
    });

    if (self.serverConnections[remoteAddr]) {
        var oldConn = self.serverConnections[remoteAddr];
        oldConn.resetAll(errors.SocketClosedError({
            reason: 'duplicate remoteAddr incoming conn'
        }));
        delete self.serverConnections[remoteAddr];
    }

    sock.on('close', onSocketClose);

    self.serverConnections[remoteAddr] = conn;
    self.emit('connection', conn);

    function onSocketClose() {
        delete self.serverConnections[remoteAddr];
    }
};

TChannel.prototype.onServerSocketListening = function onServerSocketListening() {
    var self = this;

    if (self.destroyed) {
        self.logger.error('got serverSocket listen whilst destroyed', {
            requestHostPort: self.host + ':' + self.requestedPort,
            hostPort: self.host + ':' + self.serverSocket.address().port
        });
        return;
    }

    var address = self.serverSocket.address();
    self.hostPort = self.host + ':' + address.port;
    self.listening = true;

    if (self.subChannels) {
        Object.keys(self.subChannels).forEach(function each(serviceName) {
            var chan = self.subChannels[serviceName];
            if (!chan.hostPort) {
                chan.hostPort = self.hostPort;
            }
        });
    }

    self.emit('listening');
};

TChannel.prototype.onServerSocketError = function onServerSocketError(err) {
    var self = this;

    if (err.code === 'EADDRINUSE') {
        err = errors.TChannelListenError(err, {
            requestedPort: self.requestedPort,
            host: self.host
        });
    }
    self.logger.error('server socket error', {
        err: err,
        requestedPort: self.requestedPort,
        host: self.host,
        hostPort: self.hostPort || null
    });
    self.emit('error', err);
};

TChannel.prototype.makeSubChannel = function makeSubChannel(options) {
    var self = this;
    if (!options) options = {};
    assert(!self.serviceName, 'arbitrary-depth sub channels are unsupported');
    assert(options.serviceName, 'must specify serviceName');
    assert(!self.subChannels[options.serviceName], 'duplicate sub channel creation');
    var opts = extend(self.options);
    var keys = Object.keys(options);
    for (var i = 0; i < keys.length; i++) {
        switch (keys[i]) {
            case 'peers':
                break;
            default:
                opts[keys[i]] = options[keys[i]];
        }
    }
    var chan = TChannel(opts);
    chan.topChannel = self;
    if (options.peers) {
        for (i = 0; i < options.peers.length; i++) {
            if (typeof options.peers[i] === 'string') {
                chan.peers.addPeer(self.peers.add(options.peers[i]));
            } else {
                chan.peers.addPeer(options.peers[i]);
            }
        }
    }
    self.subChannels[chan.serviceName] = chan;

    if (self.hostPort) {
        chan.hostPort = self.hostPort;
    }

    return chan;
};

TChannel.prototype.listen = function listen(port, host, callback) {
    // Note:
    // - 0 is a valid port number, indicating that the system must assign an
    //   available ephemeral port
    // - 127.0.0.1 is a valid host, primarily for testing
    var self = this;
    assert(!self.listened, 'TChannel can only listen once');
    assert(typeof host === 'string', 'TChannel requires host argument');
    assert(typeof port === 'number', 'TChannel must listen with numeric port');
    assert(host !== '0.0.0.0', 'TChannel must listen with externally visible host');
    self.listened = true;
    self.requestedPort = port;
    self.host = host;
    self.getServer().listen(port, host, callback);
};

TChannel.prototype.register = function register(name, handler) {
    var self = this;

    var handlerType = self.handler && self.handler.type;

    switch (handlerType) {
        case 'tchannel.endpoint-handler':
            self.handler.register(name, handler);
            break;

        case 'tchannel.service-name-handler':
            throw errors.TopLevelRegisterError();

        default:
            throw errors.InvalidHandlerForRegister({
                handlerType: handlerType,
                handler: self.handler
            });
    }
};

TChannel.prototype.address = function address() {
    var self = this;
    if (self.serverSocket) {
        return self.serverSocket.address() || null;
    } else if (self.topChannel) {
        return self.topChannel.address();
    } else {
        return null;
    }
};

TChannel.prototype.request = function channelRequest(options) {
    var self = this;
    assert(!self.destroyed, 'cannot request() to destroyed tchannel');

    var prop;
    var opts = {};
    // jshint forin:false
    for (prop in self.requestDefaults) {
        opts[prop] = self.requestDefaults[prop];
    }
    if (options) {
        for (prop in options) {
            opts[prop] = options[prop];
        }
    }
    // jshint forin:true

    if (!opts.service && opts.serviceName) {
        opts.service = opts.serviceName;
    }

    if (!self.serviceName && !opts.host) {
        if (opts.service &&
            self.subChannels &&
            self.subChannels[opts.service]) {
            return self.subChannels[opts.service].request(opts);
        } else {
            throw errors.TopLevelRequestError();
        }
    }

    var req = null;
    if (opts.host || // retries are only between hosts
        opts.streamed // streaming retries not yet implemented
    ) {
        req = self.peers.request(null, opts);
    } else {
        req = new TChannelRequest(self, opts);
    }
    self.emit('request', req);
    return req;
};

TChannel.prototype.quit = // to provide backward compatibility.
TChannel.prototype.close = function close(callback) {
    var self = this;
    assert(!self.destroyed, 'TChannel double close');
    self.destroyed = true;

    var counter = 1;

    if (self.serverSocket) {
        ++counter;
        if (self.serverSocket.address()) {
            closeServerSocket();
        } else {
            self.serverSocket.once('listening', closeServerSocket);
        }
    }

    if (self.serverConnections) {
        var incomingConns = Object.keys(self.serverConnections);
        for (var i = 0; i < incomingConns.length; i++) {
            ++counter;
            var incomingConn = self.serverConnections[incomingConns[i]];
            incomingConn.close(onClose);
        }
    }

    if (self.subChannels) {
        var serviceNames = Object.keys(self.subChannels);
        serviceNames.forEach(function each(serviceName) {
            var svcchan = self.subChannels[serviceName];
            if (!svcchan.destroyed) {
                counter++;
                svcchan.close(onClose);
            }
        });
    }

    self.peers.close(onClose);

    function closeServerSocket() {
        self.serverSocket.once('close', onClose);
        self.serverSocket.close();
    }

    function onClose() {
        if (--counter <= 0) {
            if (counter < 0) {
                self.logger.error('closed more channel sockets than expected', {
                    counter: counter
                });
            }
            if (typeof callback === 'function') {
                callback();
            }
        }
    }
};

module.exports = TChannel;

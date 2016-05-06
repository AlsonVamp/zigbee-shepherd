/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter,
    util = require('util'),
    _ = require('lodash');

// endpointInfo = {
//     endpointId : x,
//     profileId : x,
//     deviceId : x,
//     numIpClusters : x,
//     ipClusterList : [x, y, z, ...],
//     numOpClusters : x,
//     opClusterList : [x, y, z, ...]
// }

function Endpoint(ep) { 
    var seqNum = 0;

    this.device = null; // bind to device

    this.epId = null;
    this.profile = null;
    this.devId = null;
    this.clusters = [];
    // this.inClusters = [ { cId: 3, dir: 'in', attrs: [] }];  // [ cInfo, ... ]
    //this.outClusters = [];
    this.zclSupport = true;
    this.publicProfile = true; // isPublic

    // this is the zcl sequence number
    this.nextSeqNum = function () {
        if (++seqNum > 255)
            seqNum = 1;

        return seqNum;
    };
}


Endpoint.prototype.send = function () {};
Endpoint.prototype.numInClusters = function () {};
Endpoint.prototype.numOutClusters = function () {};
Endpoint.prototype.inClusterList = function () {};
Endpoint.prototype.outClusterList = function () {};
Endpoint.prototype.addCluster = function () {};

// ep-manager
Endpoint.prototype.dump = function () {};
Endpoint.prototype.addEps = function () {};
Endpoint.prototype.addClusters = function () {};

Endpoint.prototype.zclRequest = function (cId, valObj, callback) {};


// Foundation methods
// read, write, writeUndiv, writeNoRsp, configReport, readReportCfg, readStruct, discover, report
// readStruct and writeStrcut are not support by TI


util.inherits(Endpoint, EventEmitter);
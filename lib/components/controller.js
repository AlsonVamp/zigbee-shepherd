/* jshint node: true */
'use strict'

const EventEmitter = require('events')
const Q = require('q')
const _ = require('busyman')
const znp = require('cc-znp')
const proving = require('proving')
const ZSC = require('zstack-constants')
const debug = {
  shepherd: require('debug')('zigbee-shepherd'),
  init: require('debug')('zigbee-shepherd:init'),
  request: require('debug')('zigbee-shepherd:request'),
  response: require('debug')('zigbee-shepherd:response')
}
const Zdo = require('./zdo')
const querie = require('./querie')
const bridge = require('./event_bridge.js')
const init = require('../initializers/init_controller')
const nvParams = require('../config/nv_start_options.js')
const Device = require('../model/device')
const Coordpoint = require('../model/coordpoint')
const fs = require('fs')

/*************************************************************************************************/
/** * Private Functions                                                                         ***/
/*************************************************************************************************/

function makeRegParams(loEp) {
  return {
    endpoint: loEp.getEpId(),
    appprofid: loEp.getProfId(),
    appdeviceid: loEp.getDevId(),
    appdevver: 0,
    latencyreq: ZSC.AF.networkLatencyReq.NO_LATENCY_REQS,
    appnuminclusters: loEp.inClusterList.length,
    appinclusterlist: loEp.inClusterList,
    appnumoutclusters: loEp.outClusterList.length,
    appoutclusterlist: loEp.outClusterList
  }
}

class Controller extends EventEmitter {
  constructor(shepherd, cfg) {
    super()
    let transId = 0
    if (!_.isPlainObject(cfg)) {
      throw new TypeError('cfg should be an object.')
    }

    /***************************************************/
    /** * Protected Members                           ***/
    /***************************************************/
    this._shepherd = shepherd
    this._coord = null
    this._znp = znp
    this._cfg = cfg
    this._zdo = new Zdo(this)
    this._resetting = false
    this._spinLock = false
    this._joinQueue = []
    this._permitJoinTime = 0
    this._permitJoinInterval = null

    this._net = {
      state: null,
      channel: null,
      panId: null,
      extPanId: null,
      ieeeAddr: null,
      nwkAddr: null,
      joinTimeLeft: 0
    }

    /***************************************************/
    /** * Public Members                              ***/
    /***************************************************/
    this.querie = querie(this)

    this.nextTransId = () => { // zigbee transection id
      if (++transId > 255) {transId = 1}
      return transId
    }

    this.permitJoinCountdown = () => {
      return this._permitJoinTime -= 1
    }

    this.isResetting = () => {
      return this._resetting
    }

    /***************************************************/
    /** * Event Handlers                              ***/
    /***************************************************/
    this._znp.on('ready', () => {
      init.setupCoord(this).then(() => {
        this.emit('ZNP:INIT')
      }).fail((err) => {
        this.emit('ZNP:INIT', err)
        debug.init('Coordinator initialize had an error:', err)
      }).done()
    })

    this._znp.on('close', () => {
      this.emit('ZNP:CLOSE')
    })

    this._znp.on('AREQ', (msg) => {
      bridge._areqEventBridge(this, msg)
    })

    this.on('ZDO:endDeviceAnnceInd', (data) => {
      console.log('spinlock:', this._spinLock, this._joinQueue)
      if (this._spinLock) {
        // Check if joinQueue already has this device
        for (var i = 0; i < this._joinQueue.length; i++) {
          if (this._joinQueue[i].ieeeAddr === data.ieeeaddr) {
            console.log('already in joinqueue')
            return
          }
        }

        this._joinQueue.push({
          func: () => {
            this.endDeviceAnnceHdlr(data)
          },
          ieeeAddr: data.ieeeaddr
        })
      } else {
        this._spinLock = true
        this.endDeviceAnnceHdlr(data)
      }
    })
  }

  /*************************************************************************************************/
  /** * Public ZigBee Utility APIs                                                                ***/
  /*************************************************************************************************/
  getShepherd() {
    return this._shepherd
  }

  getCoord() {
    return this._coord
  }

  getNetInfo() {
    var net = _.cloneDeep(this._net)

    if (net.state === ZSC.ZDO.devStates.ZB_COORD) {net.state = 'Coordinator'}

    net.joinTimeLeft = this._permitJoinTime

    return net
  }

  setNetInfo(netInfo) {
    _.forEach(netInfo, (val, key) => {
      if (_.has(this._net, key)) {this._net[key] = val}
    })
  }

  /*************************************************************************************************/
  /** * Mandatory Public APIs                                                                     ***/
  /*************************************************************************************************/
  start(callback) {
    const deferred = Q.defer()
    const readyLsn = (err) => {
      return err ? deferred.reject(err) : deferred.resolve()
    }

    this.once('ZNP:INIT', readyLsn)

    Q.ninvoke(this._znp, 'init', this._cfg).fail((err) => {
      this.removeListener('ZNP:INIT', readyLsn)
      deferred.reject(err)
    }).done()

    return deferred.promise.nodeify(callback)
  }

  close(callback) {
    const deferred = Q.defer()

    const closeLsn = () => {
      deferred.resolve()
    }

    this.once('ZNP:CLOSE', closeLsn)

    Q.ninvoke(this._znp, 'close').fail((err) => {
      this.removeListener('ZNP:CLOSE', closeLsn)
      deferred.reject(err)
    }).done()

    return deferred.promise.nodeify(callback)
  }

  reset(mode, callback) {
    const deferred = Q.defer()
    const startupOption = nvParams.startupOption.value[0]

    proving.stringOrNumber(mode, 'mode should be a number or a string.')

    Q.fcall(() => {
      if (mode === 'soft' || mode === 1) {
        debug.shepherd('Starting a software reset...')
        this._resetting = true

        return this.request('SYS', 'resetReq', {type: 0x01})
      } else if (mode === 'hard' || mode === 0) {
        debug.shepherd('Starting a hardware reset...')
        this._resetting = true

        if (this._nvChanged && startupOption !== 0x02) {nvParams.startupOption.value[0] = 0x02}

        var steps = [
          () => {return this.request('SYS', 'resetReq', {type: 0x01}).delay(0)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.startupOption).delay(10)},
          () => {return this.request('SYS', 'resetReq', {type: 0x01}).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.panId).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.extPanId).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.channelList).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.logicalType).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.precfgkey).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.precfgkeysEnable).delay(10)},
          () => {return this.request('SYS', 'osalNvWrite', nvParams.securityMode).delay(10)},
          () => {return this.request('SAPI', 'writeConfiguration', nvParams.zdoDirectCb).delay(10)}
        ]

        return steps.reduce((soFar, fn) => {
          return soFar.then(fn)
        }, Q(0))
      } else {
        return Q.reject(new Error('Unknown reset mode.'))
      }
    }).then(() => {
      this._resetting = false
      if (this._nvChanged) {
        nvParams.startupOption.value[0] = startupOption
        this._nvChanged = false
        deferred.resolve()
      } else {
        this.once('_reset', (err) => {
          return err ? deferred.reject(err) : deferred.resolve()
        })
        this.emit('SYS:resetInd', '_reset')
      }
    }).fail((err) => {
      deferred.reject(err)
    }).done()

    return deferred.promise.nodeify(callback)
  };

  request(subsys, cmdId, valObj, callback) {
    const deferred = Q.defer()

    proving.stringOrNumber(subsys, 'subsys should be a number or a string.')
    proving.stringOrNumber(cmdId, 'cmdId should be a number or a string.')

    if (!_.isPlainObject(valObj) && !_.isArray(valObj)) {throw new TypeError('valObj should be an object or an array.')}

    if (_.isString(subsys)) {subsys = subsys.toUpperCase()}

    const rspHdlr = (err, rsp) => {
      if (subsys !== 'ZDO' && subsys !== 5) {
        if (rsp && rsp.hasOwnProperty('status')) {debug.request('RSP <-- %s, status: %d', subsys + ':' + cmdId, rsp.status)} else {debug.request('RSP <-- %s', subsys + ':' + cmdId)}
      }

      if (err) {
        deferred.reject(err)
      } else if ((subsys !== 'ZDO' && subsys !== 5) && rsp && rsp.hasOwnProperty('status') && rsp.status !== 0) {
        // unsuccessful
        deferred.reject(new Error('rsp error: ' + rsp.status))
      } else {
        deferred.resolve(rsp)
      }
    }

    if ((subsys === 'AF' || subsys === 4) && valObj.hasOwnProperty('transid')) {debug.request('REQ --> %s, transId: %d', subsys + ':' + cmdId, valObj.transid)} else {debug.request('REQ --> %s', subsys + ':' + cmdId)}

    if (subsys === 'ZDO' || subsys === 5) {this._zdo.request(cmdId, valObj, rspHdlr)} // use wrapped zdo as the exported api
    else {this._znp.request(subsys, cmdId, valObj, rspHdlr)} // SREQ has timeout inside znp

    return deferred.promise.nodeify(callback)
  }

  permitJoin(time, type, callback) {
    // time: seconds, 0x00 disable, 0xFF always enable
    // type: 0 (coord) / 1 (all)
    let addrmode
    let dstaddr

    proving.number(time, 'time should be a number.')
    proving.stringOrNumber(type, 'type should be a number or a string.')

    return Q.fcall(() => {
      if (type === 0 || type === 'coord') {
        addrmode = 0x02
        dstaddr = 0x0000
      } else if (type === 1 || type === 'all') {
        addrmode = 0x0F
        dstaddr = 0xFFFC // all coord and routers
      } else {
        return Q.reject(new Error('Not a valid type.'))
      }
    }).then(() => {
      if (time > 255 || time < 0) {return Q.reject(new Error('Jointime can only range from  0 to 255.'))} else {this._permitJoinTime = Math.floor(time)}
    }).then(() => {
      return this.request('ZDO', 'mgmtPermitJoinReq', {addrmode: addrmode, dstaddr: dstaddr, duration: time, tcsignificance: 0})
    }).then((rsp) => {
      this.emit('permitJoining', this._permitJoinTime)

      if (time !== 0 && time !== 255) {
        clearInterval(this._permitJoinInterval)
        this._permitJoinInterval = setInterval(() => {
          if (this.permitJoinCountdown() === 0) {clearInterval(this._permitJoinInterval)}
          this.emit('permitJoining', this._permitJoinTime)
        }, 1000)
      }
      return rsp
    }).nodeify(callback)
  }

  remove(dev, cfg, callback) {
    // cfg: { reJoin, rmChildren }
    const rmChildren_reJoin = 0x00

    if (!(dev instanceof Device)) {throw new TypeError('dev should be an instance of Device class.')} else if (!_.isPlainObject(cfg)) {throw new TypeError('cfg should be an object.')}

    cfg.reJoin = cfg.hasOwnProperty('reJoin') ? !!cfg.reJoin : true // defaults to true
    cfg.rmChildren = cfg.hasOwnProperty('rmChildren') ? !!cfg.rmChildren : false // defaults to false

    rmChildren_reJoin = cfg.reJoin ? (rmChildren_reJoin | 0x01) : rmChildren_reJoin
    rmChildren_reJoin = cfg.rmChildren ? (rmChildren_reJoin | 0x02) : rmChildren_reJoin

    const reqArgObj = {
      dstaddr: dev.getNwkAddr(),
      deviceaddress: dev.getIeeeAddr(),
      removechildren_rejoin: rmChildren_reJoin
    }

    return this.request('ZDO', 'mgmtLeaveReq', reqArgObj).then((rsp) => {
      if (rsp.status !== 0 && rsp.status !== 'SUCCESS') {return Q.reject(rsp.status)}
    }).nodeify(callback)
  };

  registerEp(loEp, callback) {
    if (!(loEp instanceof Coordpoint)) {throw new TypeError('loEp should be an instance of Coordpoint class.')}

    return this.request('AF', 'register', makeRegParams(loEp)).then((rsp) => {
      return rsp
    }).fail((err) => {
      return (err.message === 'rsp error: 184') ? this.reRegisterEp(loEp) : Q.reject(err)
    }).nodeify(callback)
  };

  deregisterEp(loEp, callback) {
    const coordEps = this.getCoord().endpoints

    if (!(loEp instanceof Coordpoint)) {throw new TypeError('loEp should be an instance of Coordpoint class.')}

    return Q.fcall(() => {
      if (!_.includes(coordEps, loEp)) {return Q.reject(new Error('Endpoint not maintained by Coordinator, cannot be removed.'))} else {return this.request('AF', 'delete', {endpoint: loEp.getEpId()})}
    }).then((rsp) => {
      delete coordEps[loEp.getEpId()]
      return rsp
    }).nodeify(callback)
  };

  reRegisterEp(loEp, callback) {
    return this.deregisterEp(loEp).then(() => {
      return this.request('AF', 'register', makeRegParams(loEp))
    }).nodeify(callback)
  }

  simpleDescReq(nwkAddr, ieeeAddr, callback) {
    return this.querie.deviceWithEndpoints(nwkAddr, ieeeAddr, callback)
  }

  bind(srcEp, cId, dstEpOrGrpId, callback) {
    return this.querie.setBindingEntry('bind', srcEp, cId, dstEpOrGrpId, callback)
  }

  unbind(srcEp, cId, dstEpOrGrpId, callback) {
    return this.querie.setBindingEntry('unbind', srcEp, cId, dstEpOrGrpId, callback)
  }

  findEndpoint(addr, epId) {
    return this.getShepherd().find(addr, epId)
  }

  setNvParams(net) {
    // net: { panId, channelList, precfgkey, precfgkeysEnable, startoptClearState }
    net = net || {}
    proving.object(net, 'opts.net should be an object.')

    _.forEach(net, (val, param) => {
      switch (param) {
        case 'panId':
          proving.number(val, 'net.panId should be a number.')
          nvParams.panId.value = [val & 0xFF, (val >> 8) & 0xFF]
          break
        case 'precfgkey':
          if (!_.isArray(val) || val.length !== 16) {throw new TypeError('net.precfgkey should be an array with 16 uint8 integers.')}
          nvParams.precfgkey.value = val
          break
        case 'precfgkeysEnable':
          proving.boolean(val, 'net.precfgkeysEnable should be a bool.')
          nvParams.precfgkeysEnable.value = val ? [0x01] : [0x00]
          break
        case 'startoptClearState':
          proving.boolean(val, 'net.startoptClearState should be a bool.')
          nvParams.startupOption.value = val ? [0x02] : [0x00]
          break
        case 'channelList':
          proving.array(val, 'net.channelList should be an array.')
          var chList = 0

          _.forEach(val, (ch) => {
            if (ch >= 11 && ch <= 26) {chList = chList | ZSC.ZDO.channelMask['CH' + ch]}
          })

          nvParams.channelList.value = [chList & 0xFF, (chList >> 8) & 0xFF, (chList >> 16) & 0xFF, (chList >> 24) & 0xFF]
          break
        default:
          throw new TypeError('Unkown argument: ' + param + '.')
      }
    })
  }

  checkNvParams(callback) {
    const bufToArray = (buf) => {
      var arr = []

      for (var i = 0; i < buf.length; i += 1) {
        arr.push(buf.readUInt8(i))
      }

      return arr
    }

    const steps = [
      () => {
        return this.request('SAPI', 'readConfiguration', nvParams.panId).delay(10).then((rsp) => {
          if (!_.isEqual(bufToArray(rsp.value), nvParams.panId.value)) return Q.reject('reset')
        })
      },
      () => {
        return this.request('SAPI', 'readConfiguration', nvParams.channelList).delay(10).then((rsp) => {
          if (!_.isEqual(bufToArray(rsp.value), nvParams.channelList.value)) return Q.reject('reset')
        })
      },
      () => {
        return this.request('SAPI', 'readConfiguration', nvParams.precfgkey).delay(10).then((rsp) => {
          if (!_.isEqual(bufToArray(rsp.value), nvParams.precfgkey.value)) return Q.reject('reset')
        })
      },
      () => {
        return this.request('SAPI', 'readConfiguration', nvParams.precfgkeysEnable).delay(10).then((rsp) => {
          if (!_.isEqual(bufToArray(rsp.value), nvParams.precfgkeysEnable.value)) return Q.reject('reset')
        })
      }
    ]

    return steps.reduce((soFar, fn) => {
      return soFar.then(fn)
    }, Q(0)).fail((err) => {
      if (err === 'reset' || err.message === 'rsp error: 2') {
        this._nvChanged = true
        debug.init('Non-Volatile memory is changed.')
        return this.reset('hard')
      } else {
        return Q.reject(err)
      }
    }).nodeify(callback)
  }

  checkOnline(dev, callback) {
    const nwkAddr = dev.getNwkAddr()
    const ieeeAddr = dev.getIeeeAddr()

    this.request('ZDO', 'nodeDescReq', {dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr}).timeout(5000).fail(() => {
      return this.request('ZDO', 'nodeDescReq', {dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr}).timeout(5000)
    }).then(() => {
      if (dev.status === 'offline') {this.emit('ZDO:endDeviceAnnceInd', {srcaddr: nwkAddr, nwkaddr: nwkAddr, ieeeaddr: ieeeAddr, capabilities: {}})}
    }).fail(() => {

    }).done()
  }

  endDeviceAnnceHdlr(data) {
    const joinEvent = 'ind:incoming' + ':' + data.ieeeaddr
    const dev = this.getShepherd()._findDevByAddr(data.ieeeaddr)

    if (dev && dev.status === 'online') { // Device has already joined, do next item in queue
      console.log('device already in network')

      if (this._joinQueue.length) {
        var next = this._joinQueue.shift()

        if (next) {
          console.log('next item in joinqueue')
          setImmediate(() => {
            next.func()
          })
        } else {
          console.log('no next item in joinqueue')
          this._spinLock = false
        }
      } else {
        this._spinLock = false
      }

      return
    }

    let joinTimeout = setTimeout(() => {
      if (this.listenerCount(joinEvent)) {
        this.emit(joinEvent, '__timeout__')
        this.getShepherd().emit('joining', {type: 'timeout', ieeeAddr: data.ieeeaddr})
      }

      joinTimeout = null
    }, 30000)

    this.once(joinEvent, () => {
      if (joinTimeout) {
        clearTimeout(joinTimeout)
        joinTimeout = null
      }

      if (this._joinQueue.length) {
        var next = this._joinQueue.shift()

        if (next) {
          setImmediate(() => {
            next.func()
          })
        } else {
          this._spinLock = false
        }
      } else {
        this._spinLock = false
      }
    })

    this.getShepherd().emit('joining', {type: 'associating', ieeeAddr: data.ieeeaddr})

    this.simpleDescReq(data.nwkaddr, data.ieeeaddr).then((devInfo) => {
      return devInfo
    }).fail(() => {
      return this.simpleDescReq(data.nwkaddr, data.ieeeaddr)
    }).then((devInfo) => {
      // Now that we have the simple description of the device clear joinTimeout
      if (joinTimeout) {
        clearTimeout(joinTimeout)
        joinTimeout = null
      }

      // Defer a promise to wait for the controller to complete the ZDO:devIncoming event!
      var processIncoming = Q.defer()
      this.emit('ZDO:devIncoming', devInfo, processIncoming.resolve, processIncoming.reject)
      return processIncoming.promise
    }).then(() => {
      this.emit(joinEvent, '__timeout__')
    }).fail(() => {
      this.getShepherd().emit('error', 'Cannot get the Node Descriptor of the Device: ' + data.ieeeaddr)
      this.getShepherd().emit('joining', {type: 'error', ieeeAddr: data.ieeeaddr})
      this.emit(joinEvent, '__timeout__')
    }).done()
  };
}

module.exports = Controller

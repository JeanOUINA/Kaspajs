const protoLoader = require('@grpc/proto-loader')
const gRPC = require('@grpc/grpc-js')

const { EventEmitter } = require('events')

module.exports = class Daemon extends EventEmitter {
  constructor (nodeAddress, readyCallback) {
    super()

    const packageDefinition = protoLoader.loadSync(__dirname + '/../protos/messages.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    })

		const { RPC } = gRPC.loadPackageDefinition(packageDefinition).protowire

    this._client = new RPC(nodeAddress, gRPC.credentials.createInsecure(), {  
      "grpc.max_receive_message_length": -1
    })

    this.waitingRequests = []
    this.subscriptions = new Map()

    this._stream = this._client.MessageStream()
    this._updateStream()

    this.on('end', async () => {
      await new Promise(resolve => { setTimeout(() => resolve(), 2000) })

      delete this._client
      delete this._stream

      this._client = new RPC(nodeAddress, gRPC.credentials.createInsecure(), {  
        "grpc.max_receive_message_length": -1
      })

      this._stream = this._client.MessageStream()
      this._updateStream()

      this.subscriptions.forEach((registeredEvents, eventName) => {
        const method = 'notify' + eventName[0].toUpperCase() + eventName.replace('Notification', 'Request')

        registeredEvents.forEach(event => {
          this._stream.write({ [ method ]: event.data })
        })
      })

      this.emit('reconnect')
    })

    if (typeof readyCallback === 'function') process.nextTick(() => readyCallback())
  }

  _updateStream () {
    this._stream.on('data', (data) =>  {
      if (!data.payload) return

      let eventName = data.payload.replace("notify", "").replace("Request", "Notification")
      eventName = eventName[0].toLowerCase() + eventName.substr(1)

      const subscriptions = this.subscriptions.get(eventName)
      if (typeof subscriptions !== 'undefined') {
        subscriptions.map(subscription => {
          subscription.callback(data[data.payload])
        })
      }

      if (!this.waitingRequests.find(request => request.name === data.payload.replace('Response', 'Request'))) return

      const request = this.waitingRequests.find(request => request.name === data.payload.replace('Response', 'Request'))
      this.waitingRequests = this.waitingRequests.filter(req => req !== request)
      
      if (data[data.payload].error) request.reject(data[data.payload].error)
      delete data[data.payload].error

      request.resolve(data[data.payload])
    })

    this._stream.on('error', (err) => {
      this.emit('err', err)
      this.emit('end')
    })

    this._stream.on('end', () => {
      this.emit('end')
    })
  }

  request (method, data) {
		return new Promise((resolve, reject) => {
      this._stream.write({ [ method ]: (data ?? {}) })

      this.waitingRequests.push({
        name: method,
        resolve,
        reject
      })
		})
	}

  subscribe (method, data, callback) {
    if (typeof data == 'function') { callback = data; data = {} }

    let eventName = method.replace("notify", "").replace("Request", "Notification")
		eventName = eventName[0].toLowerCase() + eventName.substr(1)

    const subsCache = this.subscriptions.get(eventName) ?? []
    subsCache.push({ uid: (Math.random() * 10000).toFixed(0), data, callback })
    this.subscriptions.set(eventName, subsCache)
    
    this._stream.write({ [ method ]: data })

    return subsCache[subsCache.length - 1].uid
  }

  unsubscribe (method, uid) {
    let eventName = method.replace("notify", "").replace("Request", "Notification")
		eventName = eventName[0].toLowerCase() + eventName.substr(1)

    const subsCache = this.subscriptions.get(eventName)
    subsCache = subsCache.filter(subscription => subscription.uid !== uid)
    this.subscriptions.set(eventName, subsCache)
  }
}

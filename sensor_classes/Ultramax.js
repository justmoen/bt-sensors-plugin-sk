const BTSensor = require("../BTSensor");

class Ultramax extends BTSensor {
  static Domain = BTSensor.SensorDomains.electrical
  static ImageFile = "TopbandBattery.webp"

  static TX_RX_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
  static NOTIFY_CHAR_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
  static WRITE_CHAR_UUID = "0000fff6-0000-1000-8000-00805f9b34fb";
    
  static identify(device){
    return null
  }

  async sendReadFunctionRequest(command) {
    this.debug(`${this.getName()}::sendReadFunctionRequest poll command ${command}`)
    return await this.txChar.writeValue(command);
  }

  buildPollCommand() {
    const payload = Buffer.from([0x01, 0x54, 0x00, 0x00]);

    let sum = 0;
    for (const b of payload)
      sum += b;

    sum &= 0xFF;

    return Buffer.from(
      ':' +
      payload.toString('hex').toUpperCase() +
      sum.toString(16).padStart(2, '0').toUpperCase() +
      '~',
      'ascii'
    );
  }

  checkSum(buffer) {
    if (buffer.length < 2) {
      console.log(
        `Cannot checksum ${buffer}. Invalid buffer. Buffer must be at least 2 bytes long.`
      );
      return false;
    }
      
    const data = buffer.slice(0, buffer.length - 1);
    const received = buffer[buffer.length - 1];

    let sum = 0;
    for (const b of data)
      sum += b;

    sum &= 0xFF;

    return sum === received;
  }

  initSchema(){
    this.debug(`${this.getName()}::initSchema`);

    super.initSchema();
    this.addDefaultParam("batteryID");
    this.addParameter(
      "numberOfCells",
      {
          title:'number of cells in battery',
          type: 'integer',
          default: 4,
          isRequired: true
      }
    );

    this.addDefaultPath('voltage','electrical.batteries.voltage')
      .read=
      (buffer)=>{return buffer.readUInt16BE(5) / 1000}

    this.addDefaultPath('current','electrical.batteries.current')
      .read=
      (buffer)=>{return buffer.readInt32B(7) / 100} 
  }

  getBuffer(command) {
    return new Promise(async (resolve, reject) => {
      const r = await this.sendReadFunctionRequest(command);
      let result = Buffer.alloc(256);
      let offset = 0;
      let datasize = -1;
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `Response timed out (+30s) from Ultramax device ${this.getName()}. `
          )
        );
      }, 30000);

      this.rxChar.on("valuechanged", buffer => {
        this.debug(`${this.getName()}::buffer ${buffer.toString('hex')}`);
        if (offset == 0) {
          //first packet
          if (buffer[0] !== 0xdd || buffer.length < 2 || buffer[1] !== command)
            reject(`Invalid buffer from ${this.getName()}, not processing.`);
          else datasize = buffer[3];
        }
        buffer.copy(result, offset);
        if (
          buffer[buffer.length - 1] == 0x41 &&
          offset + buffer.length - 7 == datasize
        ) {
          result = Uint8Array.prototype.slice.call(
            result,
            0,
            offset + buffer.length
          );
          this.rxChar.removeAllListeners();
          clearTimeout(timer);
          if (!this.checkSum(result))
            reject(`Invalid checksum from ${this.getName()}, not processing.`);

          resolve(result);
        }
        offset += buffer.length;
      });
    });
  }

  hasGATT() {
    this.debug(`${this.getName()}::hasGATT`);
    return true;
  }

  usingGATT() {
    this.debug(`${this.getName()}::usingGATT`);
    return true;
  }

  async emitGATT() {
    this.debug(`${this.getName()}::emitGATT`);
    try {
      this.debug(`${this.getName()}::emitGATT calling getAndEmitBatteryData`);
      await this.getAndEmitBatteryData();
      this.debug(
        `${this.getName()}::emitGATT returned from getAndEmitBatteryData`
      );
    } catch (e) {
      console.error(e);
      this.debug(
        `${this.getName()}::emitGATT Failed to emit battery data for ${this.getName()}: ${e}`
      );
    }
    // }, 10000);
  }

  async initGATTConnection(isReconnecting = false) {
    this.debug(`${this.getName()}::initGATTConnection`);

    if (this.rxChar)
      try {
        this.rxChar.removeAllListeners();
      } catch (e) {
        console.error(e);
        this.debug(e);
      }

    try {
      await super.initGATTConnection(isReconnecting);
      const gattServer = await this.getGATTServer();
      
      this.txRxService = await gattServer.getPrimaryService(
        this.constructor.TX_RX_SERVICE
      );
      this.rxChar = await this.txRxService.getCharacteristic(
        this.constructor.NOTIFY_CHAR_UUID
      );
      this.txChar = await this.txRxService.getCharacteristic(
        this.constructor.WRITE_CHAR_UUID
      );
      await this.rxChar.startNotifications();
    } catch (e) {
      console.error(e);
      this.setError(e.message);
    }

    try {
      // FIXME not really needed?
      await this.getBuffer(this.buildPollCommand());
    } catch (e) {
      console.error(e);
      this.debug(`Error encountered calling getBuffer(this.buildPollCommand())`);
    }
  }

  async getAndEmitBatteryData() {
    return this.getBuffer(this.buildPollCommand()).then((buffer) => {
      [
        "current",
        "voltage",
      ].forEach((tag) => this.emitData(tag, buffer));
    });
  }

  async initGATTInterval() {
    this.debug(
      `${this.getName()}::initGATTInterval pollFreq=${this?.pollFreq}`
    );
    this.intervalID = setInterval(
      async () => {
        this._error = false;
        if (!(await this.device.isConnected())) {
          await this.initGATTConnection(true);
        }
        await this.emitGATT();
      },
      (this?.pollFreq ?? 40) * 1000
    );

    try {
      await this.emitGATT();
    } catch (e) {
      console.error(e);
      this.setError(e.message);
    }
  }

  async initGATTNotifications() {
    this.debug(`${this.getName()}::initGATTNotifications`);
  }

  async deactivateGATT(){
    await this.stopGATTNotifications(this.rxChar)
    await super.deactivateGATT()
  }
}

module.exports = Ultramax;
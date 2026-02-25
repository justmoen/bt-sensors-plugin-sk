const BTSensor = require("../BTSensor");

const testData=[
  ['3a 30 31 35 34 30 31 30 30 45 43 30 30 30 31 30 32 30 33 30',
  '34 30 35 30 36 30 44 35 42 30 44 37 38 30 44 37 39 30 44 37',
  '39 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 46 30 30 30 30 30 30 30 34 36 34',
  '36 34 36 34 36 31 30 45 45 30 30 30 30 30 30 30 30 37 46 46',
  '46 46 46 46 46 33 35 43 35 30 30 31 45 30 34 30 30 42 34 36',
  '33 30 30 30 31 44 34 43 30 30 30 30 34 35 38 46 45 30 30 30',
  '31 44 34 43 30 30 30 30 32 30 35 46 30 30 30 30 36 30 30 30',
  '31 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
  '30 30 30 30 30 30 30 30 30 30 30 30 30 37 39 00 7e 00 00 00']
]

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
    return await this.txChar.writeValueWithoutResponse(command);
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

  initSchema(){
    this.debug(`${this.getName()}::initSchema`);

    super.initSchema();
    this.numberOfCells = 4;
    this.addDefaultParam("batteryID");
    this.addParameter(
      "numberOfCells",
      {
          title:'number of cells in battery',
          type: 'integer',
          default: this.numberOfCells,
          isRequired: true
      }
    );

    this.addDefaultPath('voltage','electrical.batteries.voltage')
      .read=
      (buffer)=>{return buffer.readUInt16BE(62) / 1000}

    this.addDefaultPath('current','electrical.batteries.current')
      .read=
      (buffer)=>{return buffer.readInt32BE(59) / 100}

    this.addDefaultPath("cycles", "electrical.batteries.cycles").read = (
      buffer
    ) => {
      return buffer.readUInt16BE(67);
    };

    for (let i = 0; i < this.numberOfCells; i++) {
      this.addMetadatum(
        `cell${i}Voltage`,
        "V",
        `Cell ${i + 1} voltage`,
        (buffer) => {
          return buffer.readUInt16BE((i * 2) + 12) / 1000;
        }
      ).default = `electrical.batteries.{batteryID}.cell${i}.voltage`;
    }

    this.addMetadatum('temp', 'C', 'Temperature reading',
      (buffer)=>{
        return buffer.readUInt16BE(64)
      }
    ).default='electrical.batteries.{batteryID}.temperature'

    this.addDefaultPath(
      "SOC",
      "electrical.batteries.capacity.stateOfCharge"
    ).read = (buffer) => {
      return buffer.readUInt8(69);
    };

    /* This is TODO:  this is difficult to reverse engineer.  Knowledge from factory would be helpful.
    // There are many 0s in the frame.  The alarm bits could be in any of these sets and there could be more than what is shown in UMXLI.
    this.addMetadatum("protectionStatus", "", "Protection Status", (buffer) => {
      const bits = buffer.readUInt16BE(55).toString(2);
      return {
        packOvervolt: bits[0] == "1",
        packUndervolt: bits[1] == "1",
        chargeOvercurrent: bits[2] == "1",
        dischargeOvercurrent: bits[3] == "1",
        chargeUndertemp: bits[4] == "1",
        dischargeUndertemp: bits[5] == "1",
        chargeUndertemp: bits[6] == "1",
        dischargeUndertemp: bits[7] == "1",
        shortCircut: bits[8] == "1",
      };
    }).default = "electrical.batteries.{batteryID}.protectionStatus";
    */
  }

  getBuffer(command) {
    return new Promise(async (resolve, reject) => {
      const r = await this.sendReadFunctionRequest(command);
      let result = Buffer.alloc(256);
      let offset = 0;
      
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `Response timed out (+30s) from Ultramax device ${this.getName()}. `
          )
        );
      }, 30000);

      const valChanged = async (buffer) => {
        buffer.copy(result, offset);
        const start = result.indexOf(':');
        const end = result.indexOf('~');
        if (
          start !== -1 &&
          end !== -1 &&
          end >= start &&
          result.readUInt8(start+1) == 48
        ) {
          result = Uint8Array.prototype.slice.call(
            result,
            start + 1,
            end
          );
          buffer = Uint8Array.prototype.slice.call(
            buffer,
            end + 1
          );
          this.rxChar.removeAllListeners();
          clearTimeout(timer);
          resolve(result);
        }
        offset += buffer.length;
      };
      this.rxChar.on("valuechanged", valChanged);
    });
  }

  hasGATT() {
    return true;
  }

  usingGATT() {
    return true;
  }

  async emitGATT() {
    try {
      await this.getAndEmitBatteryData();
    } catch (e) {
      console.error(e);
      this.debug(
        `${this.getName()}::emitGATT Failed to emit battery data for ${this.getName()}: ${e}`
      );
    }
  }

  async initGATTConnection(isReconnecting = false) {
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
    return this.getBuffer(this.buildPollCommand()).then((result) => {
      const buf = Buffer.from(result.toString().replace(/\s+/g, ''), 'hex');
      [
        "current",
        "voltage",
        "cycles",
        "temp",
        "SOC",
        //"protectionStatus",
      ].forEach((tag) => this.emitData(tag, buf));
      for (let i = 0; i < this.numberOfCells; i++) {
        this.emitData(`cell${i}Voltage`, buf);
      }
    });
  }

  async initGATTInterval() {
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
  }

  async deactivateGATT(){
    await this.stopGATTNotifications(this.rxChar)
    await super.deactivateGATT()
  }
}

module.exports = Ultramax;
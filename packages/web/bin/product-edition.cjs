'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function product() {
  const file = path.resolve(__dirname, '../../backend/deploy/product-edition.json');
  if (!fs.existsSync(file)) return {"edition":"community","label":"个人版（社区版）","accountType":"personal","productName":"skyalyticwing","binaryName":"SkyalyticWingCommunity","identifier":"com.skyalyticwing.community","dataDirectory":"SkyalyticWingCommunity","port":19111,"cliCommand":"skyalyticwing","cliAliases":["wing-community"],"updateEndpoint":"https://claw.skyalytic.com/downloads/community/latest.json"};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.edition !== 'community' || !['skyalyticwing', 'wing-community'].includes(value.cliCommand))
    throw Error('Invalid installed Wing edition');
  return {...value, cliCommand: 'skyalyticwing', cliAliases: ['wing-community']};
}
function configure() {
  const value = product();
  if (!value) return null;
  const base = process.env.SKYALYTICWING_PROFILE_ROOT || (process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  process.env.SKYALYTICWING_EDITION = value.edition;
  process.env.SKYALYTICWING_DATA_DIR = path.join(base, value.dataDirectory);
  process.env.SKYALYTICWING_WEB_DATA_DIR = path.join(process.env.SKYALYTICWING_DATA_DIR, 'web');
  delete process.env.SKYALYTICWING_SKILLS_DIR;
  return value;
}
module.exports = { product, configure };

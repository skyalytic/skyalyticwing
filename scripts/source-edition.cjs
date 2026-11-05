// This source tree builds exactly one product. It never reads the sibling tree.
'use strict';
const product = require('../config/source-edition.json');
function assertEdition(requested) {
  if (requested && requested !== product.edition) throw Error('This source tree only supports ' + product.edition);
  return product.edition;
}
function configure() { assertEdition(process.env.SKYALYTICWING_EDITION); process.env.SKYALYTICWING_EDITION = product.edition; return product; }
module.exports = { product, assertEdition, configure };

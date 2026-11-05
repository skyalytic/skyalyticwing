// Only generated directories inside a previously validated deployment root may be replaced.
const fs = require('node:fs');
const path = require('node:path');
function replaceBuildDirectory(source, target, deploymentRoot) {
  const root = fs.realpathSync(deploymentRoot);
  const destination = path.resolve(target);
  if (!destination.startsWith(root + path.sep)) throw Error('Build destination outside deployment root');
  if (!fs.statSync(source).isDirectory()) throw Error('Build source is not a directory');
  if (fs.existsSync(destination)) {
    if (fs.lstatSync(destination).isSymbolicLink() || fs.realpathSync(destination) !== destination) {
      throw Error('Build destination must not redirect through a link');
    }
    fs.rmSync(destination, { recursive: true });
  } else {
    let ancestor = path.dirname(destination);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = fs.realpathSync(ancestor);
    if (real !== root && !real.startsWith(root + path.sep)) throw Error('Build parent outside deployment root');
  }
  fs.cpSync(source, destination, { recursive: true });
}
module.exports = { replaceBuildDirectory };

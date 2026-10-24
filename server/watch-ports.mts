import { SerialPort } from 'serialport';

console.log('Watching for serial port changes... (Ctrl+C to stop)\n');

let lastPorts: string[] = [];

async function checkPorts() {
  const ports = await SerialPort.list();
  const currentPorts = ports.map(p => p.path).sort();

  // Check for added ports
  const added = currentPorts.filter(p => !lastPorts.includes(p));
  const removed = lastPorts.filter(p => !currentPorts.includes(p));

  if (added.length > 0) {
    console.log(`[${new Date().toLocaleTimeString()}] ADDED:`);
    for (const path of added) {
      const port = ports.find(p => p.path === path);
      console.log(`  ${path}`);
      if (port?.manufacturer) console.log(`    Manufacturer: ${port.manufacturer}`);
      if (port?.vendorId) console.log(`    Vendor ID: ${port.vendorId}`);
      if (port?.productId) console.log(`    Product ID: ${port.productId}`);
    }
  }

  if (removed.length > 0) {
    console.log(`[${new Date().toLocaleTimeString()}] REMOVED: ${removed.join(', ')}`);
  }

  lastPorts = currentPorts;
}

// Check every 500ms
setInterval(checkPorts, 500);
checkPorts();

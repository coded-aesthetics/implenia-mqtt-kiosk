import { SerialPort } from 'serialport';

const ports = await SerialPort.list();
console.log('Available serial ports:');
if (ports.length === 0) {
  console.log('  (none found)');
} else {
  ports.forEach(port => {
    console.log(`\n  ${port.path}`);
    if (port.manufacturer) console.log(`    Manufacturer: ${port.manufacturer}`);
    if (port.vendorId) console.log(`    Vendor ID: ${port.vendorId}`);
    if (port.productId) console.log(`    Product ID: ${port.productId}`);
    if (port.serialNumber) console.log(`    Serial: ${port.serialNumber}`);
  });
}

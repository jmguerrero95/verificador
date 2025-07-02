const fs = require('fs');
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const cron = require('node-cron');

// Crear una instancia de axios con limitación de 3 solicitudes por segundo
const http = rateLimit(axios.create(), { maxRequests: 3, perMilliseconds: 1000 });

// Función para obtener todas las direcciones bloqueadas
async function fetchBlacklistedAddresses() {
  const allAddresses = [];
  let start = 0;
  const limit = 50;

  while (true) {
    try {
      const response = await http.get('https://apilist.tronscanapi.com/api/stableCoin/blackList', {
        params: { limit, start },
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
          'Referer': 'https://tronscan.org/',
          'Origin': 'https://tronscan.org'
        }
      });

      const data = response.data?.data;
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      allAddresses.push(...data);
      start += limit;
    } catch (error) {
      console.error(`Error al obtener datos (start=${start}): ${error.message}`);
      break;
    }
  }

  return allAddresses;
}

// Función para guardar las direcciones en un archivo
function saveToFile(addresses, filePath) {
  const content = addresses.map(addr => addr.blackAddress).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Archivo actualizado con ${addresses.length} direcciones bloqueadas.`);
}

// Función principal que ejecuta la tarea
async function runTask() {
  console.log(`[${new Date().toISOString()}] Iniciando actualización de la blacklist...`);
  const addresses = await fetchBlacklistedAddresses();
  if (addresses.length > 0) {
    saveToFile(addresses, './blacklist.txt');
  } else {
    console.warn('No se obtuvieron direcciones bloqueadas.');
  }
}

// Ejecutar la tarea inmediatamente al iniciar el script
runTask();

// Programar la tarea para que se ejecute cada hora
cron.schedule('0 * * * *', runTask);

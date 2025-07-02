// src/index.js (Versión Unificada: API Express + Bot Telegram)
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs'); // File System

// Importar la lógica principal de análisis
const { evaluateAndReport } = require('./tronHelper');

// --- Configuración ---
const PORT = process.env.PORT || 5000;
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error("¡Error Fatal! El token del bot de Telegram no está configurado en .env (TELEGRAM_BOT_TOKEN)");
    process.exit(1);
}

// === 1. Inicializar Express App ===
const app = express();
app.use(cors());
app.use(express.json());

// Endpoint POST /check-wallet (opcional, para pruebas o uso futuro)
// El bot llamará directamente a evaluateAndReport, no a este endpoint.
app.post('/check-wallet', async (req, res) => {
    const { address } = req.body;
    if (!address || typeof address !== 'string' || !address.trim()) {
        return res.status(400).json({ error: 'Dirección no proporcionada o inválida' });
    }
    const trimmedAddress = address.trim();
    if (!trimmedAddress.startsWith('T') || trimmedAddress.length !== 34) {
        // Podrías añadir validación más estricta si quieres
    }
    console.log(`[API Request] Solicitud recibida para: ${trimmedAddress}`);
    try {
        // Llama a la función directamente
        const { verdict, scanned, badNeighbors, report: reportPath } = await evaluateAndReport(trimmedAddress);
        console.log(`[API Success] Reporte generado en: ${reportPath}`);
        // Devolver info y RUTA LOCAL (No URL pública)
        res.json({
            status: verdict,
            scanned,
            badNeighbors,
            reportPath // Ruta local
        });
    } catch (err) {
        console.error(`[API Error] Error evaluando ${trimmedAddress}:`, err);
        res.status(500).json({ error: 'Error interno al evaluar la wallet.' });
    }
});

// Iniciar el servidor Express
const server = app.listen(PORT, () => {
    console.log(`🚀 Servidor Express corriendo en http://localhost:${PORT}`);
    console.log(`   (Endpoint /check-wallet disponible para pruebas POST)`);
});

// === 2. Inicializar Bot de Telegram ===
const bot = new TelegramBot(token, { polling: true });
console.log("🤖 Bot de Telegram iniciado y escuchando...");

// --- Lógica del Bot (Movida desde bot.js) ---

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `¡Hola ${msg.from.first_name}! 👋\n\nEnvíame una dirección de billetera TRON (TRC20) y generaré un reporte de riesgo para ti.\n\nEjemplo: \`TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\` (reemplaza con la dirección real)`, { parse_mode: 'Markdown' }).catch(err => console.error("Error enviando /start:", err.message));
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "Simplemente envíame una dirección de billetera TRON válida que empiece con 'T' y tenga 34 caracteres. Analizaré sus interacciones recientes con USDT y te diré si tiene conexiones con direcciones bloqueadas.\n\nRecibirás un breve veredicto y un reporte PDF detallado.").catch(err => console.error("Error enviando /help:", err.message));
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) { // Ignorar comandos y mensajes vacíos
        return;
    }

    const potentialAddress = text.trim();
    if (!potentialAddress.startsWith('T') || potentialAddress.length !== 34 || !/^[a-zA-Z0-9]+$/.test(potentialAddress)) {
        bot.sendMessage(chatId, "😕 La dirección no parece tener el formato correcto de TRON (Debe empezar con 'T', tener 34 caracteres alfanuméricos). Inténtalo de nuevo.").catch(err => console.error("Error enviando mensaje de formato inválido:", err.message));
        return;
    }

    console.log(`[Bot] Recibida dirección ${potentialAddress} de ${msg.from.username || msg.from.first_name} (Chat ID: ${chatId})`);

    let waitingMessage;
    try {
        waitingMessage = await bot.sendMessage(chatId, `🔍 Analizando la dirección \`${potentialAddress}\`...\nPor favor espera, esto puede tardar un momento.`, { parse_mode: 'Markdown' });
    } catch(sendError) {
        console.error(`[Bot Error] No se pudo enviar mensaje de espera a ${chatId}:`, sendError.message);
        return; // Salir si no podemos notificar al usuario
    }

    try {
        // *** Llamada DIRECTA a la función de análisis ***
        console.log(`[Bot] Llamando a evaluateAndReport para ${potentialAddress}`);
        const { verdict, scanned, badNeighbors, report: reportPath } = await evaluateAndReport(potentialAddress);
        console.log(`[Bot] Análisis completado para ${potentialAddress}. Veredicto: ${verdict}, Reporte: ${reportPath}`);

        // Construir mensaje de resumen
        let summaryMessage = `✅ *Análisis Completado*\n\n`;
        summaryMessage += `*Billetera:* \`${potentialAddress}\`\n`;
        summaryMessage += `*Veredicto:* `;
        if (verdict === 'Blocked') summaryMessage += `🔴 *${verdict}* (BLOQUEADA)`;
        else if (verdict === 'At Risk') summaryMessage += `🟠 *${verdict}* (EN RIESGO)`;
        else summaryMessage += `🟢 *${verdict}* (SEGURA)`;
        summaryMessage += `\n*Billeteras Analizadas (hasta 2 niveles):* ${scanned}\n`;
        if (verdict === 'At Risk' && badNeighbors && badNeighbors.length > 0) {
            summaryMessage += `*Conexiones Bloqueadas Encontradas:* ${badNeighbors.length}\n`;
        }
        summaryMessage += `\nAdjunto encontrarás el reporte PDF detallado.`;

        // Enviar resumen
        await bot.sendMessage(chatId, summaryMessage, { parse_mode: 'Markdown' });

        // Verificar si la ruta del reporte existe
        if (!reportPath || !fs.existsSync(reportPath)) {
            console.error(`[Bot Error] El archivo de reporte no existe en la ruta: ${reportPath}`);
            await bot.sendMessage(chatId, "⚠️ Hubo un problema al generar o encontrar el archivo PDF del reporte. Por favor, contacta soporte.");
        } else {
            // Enviar el documento PDF
            console.log(`[Bot] Enviando documento ${reportPath} a ${chatId}`);
            await bot.sendDocument(chatId, reportPath, {
                caption: `Reporte de Análisis de Riesgo para ${potentialAddress}`
            });

            // Borrar el archivo PDF después de enviarlo
            fs.unlink(reportPath, (err) => {
                if (err) {
                    console.error(`[Bot Error] No se pudo borrar el archivo ${reportPath}:`, err);
                } else {
                    console.log(`[Bot] Archivo ${reportPath} borrado exitosamente.`);
                }
            });
        }

    } catch (error) {
        console.error(`[Bot Error] Error procesando ${potentialAddress} para ${chatId} (llamada directa a evaluateAndReport):`, error);
        // Enviar mensaje de error genérico o específico si es posible
        let userErrorMessage = "❌ Lo siento, ocurrió un error al procesar tu solicitud.";
         if (error.message.includes('All RPC providers failed')) {
             userErrorMessage += '\n\nDetalle: Error al contactar la red Tron (RPCs). Intenta más tarde.';
         } else if (error.message.includes('invalid address')) {
             userErrorMessage += '\n\nDetalle: La dirección proporcionada parece ser inválida.';
         } else {
            userErrorMessage += " Por favor, inténtalo de nuevo más tarde o contacta soporte si el problema persiste.";
         }
        await bot.sendMessage(chatId, userErrorMessage);

    } finally {
        // Borrar mensaje de espera si existe (siempre intentar)
        if (waitingMessage) {
            await bot.deleteMessage(chatId, waitingMessage.message_id).catch(delErr => console.warn("[Bot Warn] No se pudo borrar mensaje de espera:", delErr.message));
        }
    }
});

// Manejadores de errores del bot (opcional pero recomendado)
bot.on('polling_error', (error) => {
    console.error(`[Bot Polling Error] Código: ${error.code} - Mensaje: ${error.message}`);
    // Considerar estrategias de recuperación o notificación
});
bot.on('error', (error) => {
    console.error("[Bot General Error]", error);
});

console.log("--- Aplicación (API + Bot) completamente inicializada ---");
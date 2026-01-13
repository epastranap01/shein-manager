require('dotenv').config(); // Cargar variables de entorno
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuración de la Base de Datos (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Requerido para Neon
});

// --- FUNCIONES AUXILIARES ---

// MODIFICACIÓN 1: Función mejorada con "Margen Bancario"
async function getDollarRate() {
    try {
        const apiKey = process.env.EXCHANGE_API_KEY;
        const response = await axios.get(`https://v6.exchangerate-api.com/v6/${apiKey}/pair/USD/HNL`);
        
        if (response.data && response.data.conversion_rate) {
            // TRUCO: Le sumamos L. 0.18 para simular la "Venta" del banco automáticamente
            // Si la API dice 26.38 + 0.18 = 26.56 (Mucho más exacto a tu banco)
            return response.data.conversion_rate + 0.18; 
        }
        throw new Error("API falló");
    } catch (error) {
        console.error("Usando tasa respaldo 26.60");
        return 26.60; // Un valor seguro si falla internet
    }
}

// Nueva ruta para consultar la tasa desde el Frontend antes de guardar
app.get('/api/rate', async (req, res) => {
    const rate = await getDollarRate();
    res.json({ rate });
});

// MODIFICACIÓN 2: Ruta POST actualizada para aceptar tasa manual
app.post('/api/orders', async (req, res) => {
    // Ahora aceptamos "custom_rate" desde el frontend
    const { purchase_date, original_amount, currency, trackings, custom_rate } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let rate = 1;
        if (currency === 'USD') {
            // Si el usuario escribió una tasa manual, usamos esa. Si no, consultamos la API.
            rate = custom_rate ? parseFloat(custom_rate) : await getDollarRate();
        }

        const orderRes = await client.query(
            `INSERT INTO orders (purchase_date, original_amount, currency, exchange_rate) 
             VALUES ($1, $2, $3, $4) RETURNING id, exchange_rate`,
            [purchase_date, original_amount, currency, rate]
        );
        const orderId = orderRes.rows[0].id;

        if (trackings && trackings.length > 0) {
            for (const track of trackings) {
                await client.query(
                    `INSERT INTO trackings (order_id, tracking_number, carrier) VALUES ($1, $2, $3)`,
                    [orderId, track.tracking_number, track.carrier]
                );
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Pedido guardado", orderId });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// --- RUTAS (ENDPOINTS) ---

// 1. Prueba rápida para ver si todo funciona
app.get('/', (req, res) => {
    res.send('Servidor de Pedidos Shein Funcionando 🚀');
});

// 2. Registrar un NUEVO PEDIDO
app.post('/api/orders', async (req, res) => {
    const { purchase_date, original_amount, currency, trackings } = req.body;
    
    // Validar datos básicos
    if (!purchase_date || !original_amount) {
        return res.status(400).json({ error: 'Faltan datos obligatorios (fecha o monto)' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Iniciar transacción segura

        // Determinar tasa de cambio
        let rate = 1; // Si es HNL, la tasa es 1
        if (currency === 'USD') {
            rate = await getDollarRate();
        }

        // Insertar el Pedido en la tabla 'orders'
        const orderQuery = `
            INSERT INTO orders (purchase_date, original_amount, currency, exchange_rate) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, original_amount, exchange_rate`;
        
        const orderResult = await client.query(orderQuery, [purchase_date, original_amount, currency, rate]);
        const newOrder = orderResult.rows[0];

        // Insertar los Trackings (si existen)
        if (trackings && Array.isArray(trackings) && trackings.length > 0) {
            const trackingQuery = `INSERT INTO trackings (order_id, tracking_number, carrier) VALUES ($1, $2, $3)`;
            
            for (const track of trackings) {
                // track debe ser objeto: { tracking_number: "...", carrier: "UPS" }
                await client.query(trackingQuery, [newOrder.id, track.tracking_number, track.carrier || 'Desconocido']);
            }
        }

        await client.query('COMMIT'); // Guardar todo
        
        // Responder al usuario
        res.status(201).json({
            success: true,
            message: 'Pedido guardado exitosamente',
            order_id: newOrder.id,
            tasa_usada: newOrder.exchange_rate,
            total_en_lempiras: (newOrder.original_amount * newOrder.exchange_rate).toFixed(2)
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Deshacer si algo falla
        console.error("Error guardando pedido:", error);
        res.status(500).json({ error: 'Error interno del servidor', details: error.message });
    } finally {
        client.release();
    }
});

// 3. Obtener todos los pedidos
app.get('/api/orders', async (req, res) => {
    try {
        // Traemos los pedidos y usamos JSON_AGG para meter los trackings en el mismo resultado
        const result = await pool.query(`
            SELECT o.*, 
                   json_agg(json_build_object('n_guia', t.tracking_number, 'carrier', t.carrier)) as trackings
            FROM orders o
            LEFT JOIN trackings t ON o.id = t.order_id
            GROUP BY o.id
            ORDER BY o.id DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// --- NUEVAS RUTAS PARA EDICIÓN ---

// 4. Agregar un tracking extra a una orden existente
app.post('/api/orders/:id/tracking', async (req, res) => {
    const { id } = req.params;
    const { tracking_number, carrier } = req.body;
    
    try {
        await pool.query(
            `INSERT INTO trackings (order_id, tracking_number, carrier) VALUES ($1, $2, $3)`,
            [id, tracking_number, carrier]
        );
        res.json({ success: true, message: 'Nuevo tracking agregado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Actualizar Flete y Precio de Venta (Finanzas)
app.put('/api/orders/:id/financials', async (req, res) => {
    const { id } = req.params;
    // Ahora recibimos también 'original_amount'
    const { original_amount, freight_cost_hnl, selling_price_hnl } = req.body;

    try {
        await pool.query(
            `UPDATE orders 
             SET original_amount = $1, freight_cost_hnl = $2, selling_price_hnl = $3 
             WHERE id = $4`,
            [original_amount, freight_cost_hnl || 0, selling_price_hnl || 0, id]
        );
        res.json({ success: true, message: 'Pedido actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// 2. ELIMINAR PEDIDO (Nueva Ruta)
app.delete('/api/orders/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Al borrar el pedido, los trackings se borran solos si configuraste ON DELETE CASCADE en SQL
        // Si no, borramos trackings primero manualmente por seguridad:
        await pool.query('DELETE FROM trackings WHERE order_id = $1', [id]); 
        await pool.query('DELETE FROM orders WHERE id = $1', [id]);
        
        res.json({ success: true, message: 'Pedido eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});
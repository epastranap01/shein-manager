require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Servir Frontend

// Conexión Base de Datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- RUTAS SIMPLIFICADAS (SOLO LEMPIRAS) ---

// 1. Obtener todos los pedidos
app.get('/api/orders', async (req, res) => {
    try {
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

// 2. Crear Nuevo Pedido (Directo en Lempiras)
app.post('/api/orders', async (req, res) => {
    // Ya no pedimos currency ni exchange_rate
    const { purchase_date, original_amount, trackings } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Guardamos: original_amount (ahora es Lempiras), currency 'HNL', tasa 1.0
        const orderQuery = `
            INSERT INTO orders (purchase_date, original_amount, currency, exchange_rate) 
            VALUES ($1, $2, 'HNL', 1.0) 
            RETURNING id`;
        
        const orderRes = await client.query(orderQuery, [purchase_date, original_amount]);
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
        res.json({ success: true, message: "Pedido guardado" });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// 3. Actualizar Finanzas (Todo en Lempiras)
app.put('/api/orders/:id/financials', async (req, res) => {
    const { id } = req.params;
    const { original_amount, freight_cost_hnl, selling_price_hnl } = req.body;

    try {
        await pool.query(
            `UPDATE orders 
             SET original_amount = $1, freight_cost_hnl = $2, selling_price_hnl = $3 
             WHERE id = $4`,
            [original_amount, freight_cost_hnl || 0, selling_price_hnl || 0, id]
        );
        res.json({ success: true, message: 'Actualizado correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Agregar Tracking Extra
app.post('/api/orders/:id/tracking', async (req, res) => {
    const { id } = req.params;
    const { tracking_number, carrier } = req.body;
    try {
        await pool.query(
            `INSERT INTO trackings (order_id, tracking_number, carrier) VALUES ($1, $2, $3)`,
            [id, tracking_number, carrier]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Eliminar Pedido
app.delete('/api/orders/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM trackings WHERE order_id = $1', [id]); 
        await pool.query('DELETE FROM orders WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
});
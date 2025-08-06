// server.js - Optimized for Render.com
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 10000;

// PostgreSQL connection (Render provides DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
    console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('❌ PostgreSQL connection error:', err);
});

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests from this IP' }
});
app.use('/api', limiter);

// Routes
app.get('/', (req, res) => {
    res.json({
        name: 'CARAMEL API',
        version: '1.0.0',
        status: 'running',
        platform: 'Render.com',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET /',
            'GET /api/health',
            'GET /api/products',
            'GET /api/categories',
            'POST /api/orders',
            'POST /api/preorders',
            'GET /api/settings'
        ]
    });
});

app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
        res.json({
            status: 'healthy',
            database: 'connected',
            timestamp: result.rows[0].current_time,
            database_version: result.rows[0].pg_version
        });
    } catch (err) {
        console.error('Health check failed:', err);
        res.status(500).json({
            status: 'error',
            database: 'disconnected',
            error: err.message
        });
    }
});

// Get all categories
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, COUNT(p.id) as product_count 
            FROM categories c 
            LEFT JOIN products p ON c.id = p.category_id AND p.is_active = true
            GROUP BY c.id 
            ORDER BY c.name
        `);
        res.json({
            success: true,
            count: result.rows.length,
            categories: result.rows
        });
    } catch (err) {
        console.error('Error fetching categories:', err);
        res.status(500).json({ 
            success: false,
            error: 'Error fetching categories',
            details: err.message 
        });
    }
});

// Get all products
app.get('/api/products', async (req, res) => {
    try {
        const { category, search, limit = 50 } = req.query;
        
        let query = `
            SELECT p.*, c.name as category_name, c.slug as category_slug
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.is_active = true
        `;
        const params = [];
        
        if (category && category !== 'all') {
            query += ' AND c.slug = $1';
            params.push(category);
        }
        
        if (search) {
            const searchIndex = params.length + 1;
            query += ` AND (p.name ILIKE $${searchIndex} OR p.description ILIKE $${searchIndex})`;
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        res.json({
            success: true,
            count: result.rows.length,
            products: result.rows
        });
    } catch (err) {
        console.error('Error fetching products:', err);
        res.status(500).json({ 
            success: false,
            error: 'Error fetching products',
            details: err.message 
        });
    }
});

// Create order
app.post('/api/orders', async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { customer, items, totalAmount, notes, deliveryAddress, deliveryDate } = req.body;
        
        if (!items || items.length === 0) {
            return res.status(400).json({ 
                success: false,
                error: 'Order must contain items' 
            });
        }
        
        // Create or find customer
        let customerId = null;
        if (customer && customer.phone) {
            const customerResult = await client.query(
                `INSERT INTO customers (name, phone, email, address) 
                 VALUES ($1, $2, $3, $4) 
                 ON CONFLICT (phone) DO UPDATE SET 
                 name = EXCLUDED.name, 
                 email = EXCLUDED.email,
                 address = EXCLUDED.address,
                 updated_at = CURRENT_TIMESTAMP
                 RETURNING id`,
                [customer.name, customer.phone, customer.email || null, customer.address || null]
            );
            customerId = customerResult.rows[0].id;
        }
        
        // Create order
        const orderNumber = 'CR' + Date.now().toString().substr(-8);
        const orderResult = await client.query(`
            INSERT INTO orders (
                customer_id, order_number, total_amount, notes, 
                delivery_address, delivery_date, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'new')
            RETURNING id, order_number
        `, [customerId, orderNumber, totalAmount, notes, deliveryAddress, deliveryDate]);
        
        const orderId = orderResult.rows[0].id;
        
        // Add order items
        for (const item of items) {
            await client.query(`
                INSERT INTO order_items (
                    order_id, product_id, product_name, 
                    quantity, price, total_price
                )
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [orderId, item.id, item.name, item.quantity, item.price, item.price * item.quantity]);
        }
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            orderId: orderId,
            orderNumber: orderResult.rows[0].order_number,
            message: 'Order created successfully'
        });
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Order creation error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Order creation failed',
            details: err.message 
        });
    } finally {
        client.release();
    }
});

// Create preorder
app.post('/api/preorders', async (req, res) => {
    try {
        const { 
            customer, eventType, eventDate, eventTime,
            guestCount, budgetRange, selectedDesserts, specialRequests 
        } = req.body;
        
        if (!customer || !eventType || !eventDate) {
            return res.status(400).json({ 
                success: false,
                error: 'Required fields missing' 
            });
        }
        
        // Create customer
        let customerId = null;
        if (customer.phone) {
            const customerResult = await pool.query(
                `INSERT INTO customers (name, phone, email) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (phone) DO UPDATE SET 
                 name = EXCLUDED.name, 
                 updated_at = CURRENT_TIMESTAMP
                 RETURNING id`,
                [customer.name, customer.phone, customer.email]
            );
            customerId = customerResult.rows[0].id;
        }
        
        // Create preorder
        const result = await pool.query(`
            INSERT INTO preorders (
                customer_id, event_type, event_date, event_time,
                guest_count, budget_range, selected_desserts, special_requests
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [
            customerId, eventType, eventDate, eventTime,
            guestCount, budgetRange, selectedDesserts, specialRequests
        ]);
        
        res.json({
            success: true,
            preorderId: result.rows[0].id,
            message: 'Preorder created successfully'
        });
        
    } catch (err) {
        console.error('Preorder creation error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Preorder creation failed',
            details: err.message 
        });
    }
});

// Get settings
app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT setting_key, setting_value, description FROM site_settings');
        const settings = {};
        result.rows.forEach(row => {
            settings[row.setting_key] = {
                value: row.setting_value,
                description: row.description
            };
        });
        res.json({
            success: true,
            settings: settings
        });
    } catch (err) {
        console.error('Settings fetch error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Settings fetch failed',
            details: err.message 
        });
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        success: false,
        error: 'API endpoint not found',
        path: req.originalUrl,
        available_endpoints: [
            'GET /',
            'GET /api/health',
            'GET /api/products',
            'GET /api/categories',
            'POST /api/orders',
            'POST /api/preorders',
            'GET /api/settings'
        ]
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 CARAMEL API running on port ${port}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔗 Health check: http://localhost:${port}/health`);
});

module.exports = app;

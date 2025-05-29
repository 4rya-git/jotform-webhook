require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xmlrpc = require('xmlrpc');
const axios = require('axios');

const app = express();
const upload = multer();

const {
    ODOO_URL,
    ODOO_DB,
    ODOO_USERNAME,
    ODOO_PASSWORD,
    FULFILLMENT_API_URL,
    FULFILLMENT_API_KEY,
    PORT
} = process.env;

// Odoo XML-RPC clients
const common = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
const object = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

// Authenticate at startup
let uid = null;
common.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, res) => {
    if (err || !res) {
        console.error('Odoo auth failed:', err || 'Invalid credentials');
        process.exit(1);
    }
    uid = res;
    console.log('Connected to Odoo, UID:', uid);
});

app.post('/webhook', upload.none(), async (req, res) => {
    try {
        const rawRequest = JSON.parse(req.body.rawRequest);
        const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
        const customerEmail = rawRequest.q3_email3 || `${Date.now()}@noemail.com`; // fallback if email is empty
        const contactNumber = rawRequest.q5_contactNumber.full || '';
        const billing = rawRequest.q4_billingAddress || {};
        const products = rawRequest.q43_myProducts.products || [];

        // Step 1: Find or create customer
        const customerId = await new Promise((resolve, reject) => {
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'res.partner', 'search',
                [[['email', '=', customerEmail]]]
            ], (err, ids) => {
                if (err) return reject(err);
                if (ids.length) return resolve(ids[0]);

                // Create new customer if not found
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'res.partner', 'create',
                    [{
                        name: customerName,
                        email: customerEmail,
                        phone: contactNumber,
                        street: billing.addr_line1,
                        street2: billing.addr_line2,
                        city: billing.city,
                        zip: billing.postal,
                        country_id: null // Add logic to map country name to ID if needed
                    }]
                ], (err, newId) => {
                    if (err) return reject(err);
                    resolve(newId);
                });
            });
        });

        // Step 2: Prepare order lines
        const orderLinePromises = products.map(product => {
            return new Promise((resolve, reject) => {
                // Search for the product by name
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'product.product', 'search_read',
                    [[['name', '=', product.productName]]],
                    { fields: ['id', 'product_tmpl_id', 'uom_id'], limit: 1 }
                ], (err, result) => {
                    if (err) return reject(err);

                    // If product found, use it; otherwise, create a new product
                    if (result.length) {
                        const productId = result[0].id;
                        const uomId = result[0].uom_id[0]; // Assuming uom_id is a tuple with ID
                        return resolve([ 
                            0, 0, {
                                product_id: productId,
                                product_uom: uomId,
                                name: product.productName,
                                product_uom_qty: product.quantity,
                                price_unit: product.unitPrice
                            }
                        ]);
                    }

                    // If product not found, create it
                    object.methodCall('execute_kw', [
                        ODOO_DB, uid, ODOO_PASSWORD,
                        'product.product', 'create',
                        [{
                            name: product.productName,
                            list_price: product.unitPrice,
                            type: 'consu',  // or 'product' based on your use case
                            uom_id: 1,  // Default unit of measure ID, adjust as needed
                            categ_id: 1  // Default category ID, adjust as needed
                        }]
                    ], (err, newId) => {
                        if (err) return reject(err);
                        resolve([ 
                            0, 0, {
                                product_id: newId,
                                product_uom: 1,  // Set default UOM, adjust based on actual data
                                name: product.productName,
                                product_uom_qty: product.quantity,
                                price_unit: product.unitPrice
                            }
                        ]);
                    });
                });
            });
        });

        // Wait for all order lines to be prepared
        const orderLines = await Promise.all(orderLinePromises);

        // Step 3: Create the sale order
        const saleOrderId = await new Promise((resolve, reject) => {
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'sale.order', 'create',
                [{
                    partner_id: customerId,
                    order_line: orderLines
                }]
            ], (err, id) => {
                if (err) return reject(err);
                resolve(id);
            });
        });

        // Step 4: Confirm the sale order
        await new Promise((resolve, reject) => {
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'sale.order', 'action_confirm',
                [saleOrderId]
            ], (err, result) => {
                if (err) return reject(err);
                resolve(result);
            });
        });

        res.status(200).send('Order received and processed');
    } catch (error) {
        console.error('Webhook error:', error.message, error.stack);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
});

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

// Authenticate once at startup
let uid = null;
common.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, res) => {
    if (err) return console.error('Odoo auth failed:', err);
    uid = res;
    console.log('Connected to Odoo, UID:', uid);
});

app.post('/webhook', upload.none(), async (req, res) => {
    try {
        const rawRequest = JSON.parse(req.body.rawRequest);
        const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
        const customerEmail = rawRequest.q3_email3;
        const contactNumber = rawRequest.q5_contactNumber.full;
        const billing = rawRequest.q4_billingAddress;
        const products = rawRequest.q43_myProducts.products;

        // Step 1: Find or Create Customer in Odoo
        const customerId = await new Promise((resolve, reject) => {
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'res.partner', 'search',
                [[['email', '=', customerEmail]]]
            ], (err, ids) => {
                if (err) return reject(err);
                if (ids.length) return resolve(ids[0]);

                // Create if not found
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
                        state_id: null,
                        country_id: null
                    }]
                ], (err, newId) => {
                    if (err) return reject(err);
                    resolve(newId);
                });
            });
        });

        // Step 2: Create Sales Order in Odoo
        const orderLinePromises = products.map(product => {
            return new Promise((resolve, reject) => {
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'product.product', 'search_read',
                    [[['name', '=', product.productName]]],
                    { fields: ['id'], limit: 1 }
                ], (err, res) => {
                    if (err) return reject(err);
                    const productId = res.length ? res[0].id : null;
                    resolve([
                        0, 0, {
                            product_id: productId,
                            name: product.productName,
                            product_uom_qty: product.quantity,
                            price_unit: product.unitPrice
                        }
                    ]);
                });
            });
        });

        const orderLines = await Promise.all(orderLinePromises);

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

        // Step 3: Confirm Sale Order (optional)
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

        // // Step 4: Trigger fulfillment API
        // await axios.post(FULFILLMENT_API_URL, {
        //     customer: {
        //         name: customerName,
        //         email: customerEmail,
        //         phone: contactNumber,
        //         address: billing
        //     },
        //     order: products
        // }, {
        //     headers: {
        //         'Authorization': `Bearer ${FULFILLMENT_API_KEY}`,
        //         'Content-Type': 'application/json'
        //     }
        // });

        res.status(200).send('Order received and processed.');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
});

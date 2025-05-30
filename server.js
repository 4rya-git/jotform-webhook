require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xmlrpc = require('xmlrpc');

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

// Helper function to create or find a customer
async function createOrFindCustomer(customerName, customerEmail, contactNumber, billing) {
    return new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'res.partner', 'search',
            [[['email', '=', customerEmail]]]
        ], (err, ids) => {
            if (err) return reject(err);
            if (ids.length) return resolve(ids[0]);

            // Customer doesn't exist, create a new one
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'res.partner', 'create',
                [{
                    name: customerName,
                    email: customerEmail,
                    phone: contactNumber,
                    street: billing.addr_line1 || '',
                    street2: billing.addr_line2 || '',
                    city: billing.city || '',
                    zip: billing.postal || '',
                    country_id: null // You may need to map country names to IDs
                }]
            ], (err, newId) => {
                if (err) return reject(err);
                resolve(newId);
            });
        });
    });
}

// Helper function to create or find a product
async function findOrCreateProduct(productName, price) {
    return new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'product.product', 'search_read',
            [[['name', '=', productName]]],
            { fields: ['id'], limit: 1 }
        ], (err, result) => {
            if (err) return reject(err);
            if (result.length > 0) {
                return resolve(result[0].id);
            }

            // Product not found, create a new one
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'product.product', 'create',
                [{
                    name: productName,
                    list_price: price,
                    type: 'consu'
                }]
            ], (err, newId) => {
                if (err) return reject(err);
                resolve(newId);
            });
        });
    });
}

// Helper function to create a sale order
async function createSaleOrder(customerId, orderLines) {
    return new Promise((resolve, reject) => {
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
}

// Helper function to confirm a sale order
async function confirmSaleOrder(saleOrderId) {
    return new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'sale.order', 'action_confirm',
            [saleOrderId]
        ], (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// Main webhook route to handle incoming form submissions
app.post('/webhook', upload.none(), async (req, res) => {
    try {
        console.log('Received webhook data:', JSON.stringify(req.body, null, 2));
        
        // Parse the rawRequest field which contains the actual form data
        const rawRequest = JSON.parse(req.body.rawRequest);
        
        const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
        const customerEmail = rawRequest.q3_email3 || `${Date.now()}@noemail.com`;
        const contactNumber = rawRequest.q5_contactNumber.full || '';
        const billing = rawRequest.q4_billingAddress || {};

        // Updated product mapping with correct pricing
        const productMapping = {
            'special_1001': { name: 'T-Shirt', price: 1.00 },
            'special_1002': { name: 'Sweatshirt', price: 5.00 },
            'special_1003': { name: 'Shoes', price: 10.00 }
        };

        // Parse product data from the correct structure
        const myProducts = rawRequest.q43_myProducts;
        let orderLines = [];

        // Process each product in the special items
        for (const [productKey, productData] of Object.entries(myProducts)) {
            // Skip non-product entries
            if (productKey === 'products' || productKey === 'totalInfo') {
                continue;
            }

            const mappedProduct = productMapping[productKey];
            if (!mappedProduct) {
                console.log(`Product ${productKey} not found in mapping`);
                continue;
            }

            const quantity = parseInt(productData.item_0) || 1;
            
            // Build product description with options
            let productDescription = mappedProduct.name;
            const options = [];
            
            if (productData.item_1) {
                options.push(`Color: ${productData.item_1}`);
            }
            if (productData.item_2) {
                if (productKey === 'special_1001' || productKey === 'special_1002') {
                    options.push(`Size: ${productData.item_2}`);
                } else if (productKey === 'special_1003') {
                    options.push(`Shoe Size: ${productData.item_2}`);
                }
            }
            
            if (options.length > 0) {
                productDescription += ` (${options.join(', ')})`;
            }

            orderLines.push({
                name: productDescription,
                quantity: quantity,
                price: mappedProduct.price,
                productKey: productKey
            });
        }

        console.log('Processed order lines:', orderLines);

        if (orderLines.length === 0) {
            throw new Error('No valid products found in the order');
        }

        // Step 1: Find or create customer
        const customerId = await createOrFindCustomer(customerName, customerEmail, contactNumber, billing);

        // Step 2: Prepare Odoo order lines
        const odooOrderLines = [];
        for (const orderLine of orderLines) {
            const productId = await findOrCreateProduct(orderLine.name, orderLine.price);
            odooOrderLines.push([
                0, 0, {
                    product_id: productId,
                    name: orderLine.name,
                    product_uom_qty: orderLine.quantity,
                    price_unit: orderLine.price
                }
            ]);
        }

        // Step 3: Create sale order
        const saleOrderId = await createSaleOrder(customerId, odooOrderLines);
        console.log('Created sale order with ID:', saleOrderId);

        // Step 4: Confirm sale order
        await confirmSaleOrder(saleOrderId);
        console.log('Sale order confirmed');

        res.status(200).json({
            success: true,
            message: 'Order received and processed',
            saleOrderId: saleOrderId,
            orderLines: orderLines
        });

    } catch (error) {
        console.error('Webhook error:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start the webhook server
app.listen(PORT || 3000, () => {
    console.log(`Webhook server listening on port ${PORT || 3000}`);
});

// require('dotenv').config();
// const express = require('express');
// const multer = require('multer');
// const xmlrpc = require('xmlrpc');
// const axios = require('axios');

// const app = express();
// const upload = multer();

// const {
//     ODOO_URL,
//     ODOO_DB,
//     ODOO_USERNAME,
//     ODOO_PASSWORD,
//     FULFILLMENT_API_URL,
//     FULFILLMENT_API_KEY,
//     PORT
// } = process.env;

// // Odoo XML-RPC clients
// const common = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
// const object = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

// // Authenticate at startup
// let uid = null;
// common.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, res) => {
//     if (err || !res) {
//         console.error('Odoo auth failed:', err || 'Invalid credentials');
//         process.exit(1);
//     }
//     uid = res;
//     console.log('Connected to Odoo, UID:', uid);
// });

// // Helper function to create or find a customer
// async function createOrFindCustomer(customerName, customerEmail, contactNumber, billing) {
//     return new Promise((resolve, reject) => {
//         object.methodCall('execute_kw', [
//             ODOO_DB, uid, ODOO_PASSWORD,
//             'res.partner', 'search',
//             [[['email', '=', customerEmail]]]
//         ], (err, ids) => {
//             if (err) return reject(err);
//             if (ids.length) return resolve(ids[0]);

//             // Customer doesn't exist, create a new one
//             object.methodCall('execute_kw', [
//                 ODOO_DB, uid, ODOO_PASSWORD,
//                 'res.partner', 'create',
//                 [{
//                     name: customerName,
//                     email: customerEmail,
//                     phone: contactNumber,
//                     street: billing.addr_line1,
//                     street2: billing.addr_line2,
//                     city: billing.city,
//                     zip: billing.postal,
//                     country_id: null // Country ID can be mapped here
//                 }]
//             ], (err, newId) => {
//                 if (err) return reject(err);
//                 resolve(newId);
//             });
//         });
//     });
// }

// // Helper function to create or find a product
// async function findOrCreateProduct(productName, price) {
//     return new Promise((resolve, reject) => {
//         object.methodCall('execute_kw', [
//             ODOO_DB, uid, ODOO_PASSWORD,
//             'product.product', 'search_read',
//             [[['name', '=', productName]]],
//             { fields: ['id'], limit: 1 }
//         ], (err, result) => {
//             if (err) return reject(err);
//             if (result.length > 0) {
//                 return resolve(result[0].id);  // Return existing product ID
//             }

//             // Product not found, create a new one
//             object.methodCall('execute_kw', [
//                 ODOO_DB, uid, ODOO_PASSWORD,
//                 'product.product', 'create',
//                 [{
//                     name: productName,
//                     list_price: price,
//                     type: 'consu' // Consumable product type
//                 }]
//             ], (err, newId) => {
//                 if (err) return reject(err);
//                 resolve(newId);  // Return newly created product ID
//             });
//         });
//     });
// }

// // Helper function to create a sale order
// async function createSaleOrder(customerId, orderLines) {
//     return new Promise((resolve, reject) => {
//         object.methodCall('execute_kw', [
//             ODOO_DB, uid, ODOO_PASSWORD,
//             'sale.order', 'create',
//             [{
//                 partner_id: customerId,
//                 order_line: orderLines
//             }]
//         ], (err, id) => {
//             if (err) return reject(err);
//             resolve(id);
//         });
//     });
// }

// // Helper function to confirm a sale order
// async function confirmSaleOrder(saleOrderId) {
//     return new Promise((resolve, reject) => {
//         object.methodCall('execute_kw', [
//             ODOO_DB, uid, ODOO_PASSWORD,
//             'sale.order', 'action_confirm',
//             [saleOrderId]
//         ], (err, result) => {
//             if (err) return reject(err);
//             resolve(result);
//         });
//     });
// }

// // Main webhook route to handle incoming form submissions
// app.post('/webhook', upload.none(), async (req, res) => {
//     try {
//         const rawRequest = JSON.parse(req.body.rawRequest);
//         const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
//         const customerEmail = rawRequest.q3_email3 || `${Date.now()}@noemail.com`; // fallback if email is empty
//         const contactNumber = rawRequest.q5_contactNumber.full || '';
//         const billing = rawRequest.q4_billingAddress || {};

//         // Parse product data from the special fields
//         const products = rawRequest.q43_myProducts;
//         let orderLines = Object.values(products).map(product => {
//             return {
//                 product_id: null,  // This will be updated after product search
//                 name: product.item_1,  // Assuming item_1 is the product name or variant
//                 product_uom_qty: parseInt(product.item_0),  // Quantity
//                 price_unit: parseFloat(product.item_2) || 0  // Price, fallback to 0 if empty
//             };
//         }).filter(line => line.product_uom_qty > 0);  // Filter out products with no quantity

//         // Step 1: Find or create customer
//         const customerId = await createOrFindCustomer(customerName, customerEmail, contactNumber, billing);

//         // Step 2: Map products to Odoo order lines
//         const orderLinePromises = orderLines.map(async (orderLine) => {
//             const product = await findOrCreateProduct(orderLine.name, orderLine.price_unit);
//             return [
//                 0, 0, {
//                     product_id: product,
//                     name: orderLine.name,
//                     product_uom_qty: orderLine.product_uom_qty,
//                     price_unit: orderLine.price_unit
//                 }
//             ];
//         });

//         orderLines = await Promise.all(orderLinePromises);

//         // Step 3: Create sale order
//         const saleOrderId = await createSaleOrder(customerId, orderLines);

//         // Step 4: Confirm sale order
//         await confirmSaleOrder(saleOrderId);

//         res.status(200).send('Order received and processed');
//     } catch (error) {
//         console.error('Webhook error:', error.message, error.stack);
//         res.status(500).send('Internal Server Error');
//     }
// });

// // Start the webhook server
// app.listen(PORT, () => {
//     console.log(`Webhook server listening on port ${PORT}`);
// });




// require('dotenv').config();
// const express = require('express');
// const multer = require('multer');
// const xmlrpc = require('xmlrpc');
// const axios = require('axios');

// const app = express();
// const upload = multer();

// const {
//     ODOO_URL,
//     ODOO_DB,
//     ODOO_USERNAME,
//     ODOO_PASSWORD,
//     FULFILLMENT_API_URL,
//     FULFILLMENT_API_KEY,
//     PORT
// } = process.env;

// // Odoo XML-RPC clients
// const common = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
// const object = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

// // Authenticate once at startup
// let uid = null;
// common.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], (err, res) => {
//     if (err) return console.error('Odoo auth failed:', err);
//     uid = res;
//     console.log('Connected to Odoo, UID:', uid);
// });

// app.post('/webhook', upload.none(), async (req, res) => {
//     try {
//         const rawRequest = JSON.parse(req.body.rawRequest);
//         const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
//         const customerEmail = rawRequest.q3_email3;
//         const contactNumber = rawRequest.q5_contactNumber.full;
//         const billing = rawRequest.q4_billingAddress;
//         const products = rawRequest.q43_myProducts.products;

//         // Step 1: Find or Create Customer in Odoo
//         const customerId = await new Promise((resolve, reject) => {
//             object.methodCall('execute_kw', [
//                 ODOO_DB, uid, ODOO_PASSWORD,
//                 'res.partner', 'search',
//                 [[['email', '=', customerEmail]]]
//             ], (err, ids) => {
//                 if (err) return reject(err);
//                 if (ids.length) return resolve(ids[0]);

//                 // Create if not found
//                 object.methodCall('execute_kw', [
//                     ODOO_DB, uid, ODOO_PASSWORD,
//                     'res.partner', 'create',
//                     [{
//                         name: customerName,
//                         email: customerEmail,
//                         phone: contactNumber,
//                         street: billing.addr_line1,
//                         street2: billing.addr_line2,
//                         city: billing.city,
//                         zip: billing.postal,
//                         state_id: null,
//                         country_id: null
//                     }]
//                 ], (err, newId) => {
//                     if (err) return reject(err);
//                     resolve(newId);
//                 });
//             });
//         });

//         // Step 2: Create Products in Odoo
//         const productPromises = products.map(product => {
//             return new Promise((resolve, reject) => {
//                 object.methodCall('execute_kw', [
//                     ODOO_DB, uid, ODOO_PASSWORD,
//                     'product.product', 'search',
//                     [[['default_code', '=', product.id]]]
//                 ], (err, ids) => {
//                     if (err) return reject(err);
//                     if (ids.length) return resolve(ids[0]);

//                     // Create product if not found
//                     object.methodCall('execute_kw', [
//                         ODOO_DB, uid, ODOO_PASSWORD,
//                         'product.product', 'create',
//                         [{
//                             default_code: product.id,
//                             name: product.productName,
//                             list_price: product.unitPrice,
//                             type: 'product',
//                             uom_id: 1, // Assuming 'Unit of Measure' ID is 1
//                             uom_po_id: 1 // Assuming 'Purchase UOM' ID is 1
//                         }]
//                     ], (err, newId) => {
//                         if (err) return reject(err);
//                         resolve(newId);
//                     });
//                 });
//             });
//         });

//         const productIds = await Promise.all(productPromises);

//         // Step 3: Create Sale Order in Odoo
//         const orderLineData = productIds.map((productId, index) => {
//             const product = products[index];
//             return [
//                 0, 0, {
//                     product_id: productId,
//                     name: product.productName,
//                     product_uom_qty: product.quantity,
//                     price_unit: product.unitPrice
//                 }
//             ];
//         });

//         const saleOrderId = await new Promise((resolve, reject) => {
//             object.methodCall('execute_kw', [
//                 ODOO_DB, uid, ODOO_PASSWORD,
//                 'sale.order', 'create',
//                 [{
//                     partner_id: customerId,
//                     order_line: orderLineData
//                 }]
//             ], (err, id) => {
//                 if (err) return reject(err);
//                 resolve(id);
//             });
//         });

//         // Step 4: Confirm Sale Order (optional)
//         await new Promise((resolve, reject) => {
//             object.methodCall('execute_kw', [
//                 ODOO_DB, uid, ODOO_PASSWORD,
//                 'sale.order', 'action_confirm',
//                 [saleOrderId]
//             ], (err, result) => {
//                 if (err) return reject(err);
//                 resolve(result);
//             });
//         });

//         // Step 5: Trigger fulfillment API
//         await axios.post(FULFILLMENT_API_URL, {
//             customer: {
//                 name: customerName,
//                 email: customerEmail,
//                 phone: contactNumber,
//                 address: billing
//             },
//             order: products
//         }, {
//             headers: {
//                 'Authorization': `Bearer ${FULFILLMENT_API_KEY}`,
//                 'Content-Type': 'application/json'
//             }
//         });

//         res.status(200).send('Order received and processed.');
//     } catch (error) {
//         console.error('Webhook error:', error);
//         res.status(500).send('Internal Server Error');
//     }
// });

// app.listen(PORT, () => {
//     console.log(`Webhook server listening on port ${PORT}`);
// });

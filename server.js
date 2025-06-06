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

// Helper function to create invoice from sale order (Simple approach)
async function createInvoiceFromSaleOrder(saleOrderId) {
    return new Promise((resolve, reject) => {
        // Get the sale order data first
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'sale.order', 'read',
            [saleOrderId],
            { fields: ['partner_id', 'order_line', 'name'] }
        ], (err, saleOrderData) => {
            if (err) return reject(err);
            
            const saleOrder = saleOrderData[0];
            
            // Create invoice directly
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'account.move', 'create',
                [{
                    'move_type': 'out_invoice',
                    'partner_id': saleOrder.partner_id[0],
                    'invoice_origin': saleOrder.name,
                    'invoice_line_ids': []
                }]
            ], (createErr, invoiceId) => {
                if (createErr) return reject(createErr);
                
                // Get order lines and create invoice lines
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'sale.order.line', 'read',
                    [saleOrder.order_line],
                    { fields: ['product_id', 'name', 'product_uom_qty', 'price_unit'] }
                ], (lineErr, orderLines) => {
                    if (lineErr) return reject(lineErr);
                    
                    const invoiceLines = orderLines.map(line => [0, 0, {
                        'product_id': line.product_id[0],
                        'name': line.name,
                        'quantity': line.product_uom_qty,
                        'price_unit': line.price_unit
                    }]);
                    
                    // Update invoice with lines
                    object.methodCall('execute_kw', [
                        ODOO_DB, uid, ODOO_PASSWORD,
                        'account.move', 'write',
                        [invoiceId, { 'invoice_line_ids': invoiceLines }]
                    ], (updateErr) => {
                        if (updateErr) return reject(updateErr);
                        resolve(invoiceId);
                    });
                });
            });
        });
    });
}

// Helper function to post/validate an invoice
async function postInvoice(invoiceId) {
    return new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'account.move', 'action_post',
            [invoiceId]
        ], (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// Helper function to get invoice details
async function getInvoiceDetails(invoiceId) {
    return new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'account.move', 'read',
            [invoiceId],
            { fields: ['name', 'state', 'amount_total', 'currency_id'] }
        ], (err, result) => {
            if (err) return reject(err);
            resolve(result[0]);
        });
    });
}

// Helper function to send invoice by email
async function sendInvoiceByEmail(invoiceId) {
    return new Promise((resolve, reject) => {
        // First, get the email template for invoices
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'mail.template', 'search',
            [[['model', '=', 'account.move'], ['name', 'ilike', 'invoice']]]
        ], (err, templateIds) => {
            if (err) return reject(err);
            
            // Use the first invoice template found, or create a simple email
            const templateId = templateIds.length > 0 ? templateIds[0] : null;
            
            if (templateId) {
                // Send using template
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'mail.template', 'send_mail',
                    [templateId, invoiceId],
                    { 'force_send': true }
                ], (sendErr, result) => {
                    if (sendErr) return reject(sendErr);
                    resolve(result);
                });
            } else {
                // Create and send email manually
                sendInvoiceEmailManually(invoiceId, resolve, reject);
            }
        });
    });
}

// Helper function to send invoice email manually
function sendInvoiceEmailManually(invoiceId, resolve, reject) {
    // Get invoice details first
    object.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_PASSWORD,
        'account.move', 'read',
        [invoiceId],
        { fields: ['name', 'partner_id', 'amount_total', 'currency_id'] }
    ], (err, invoiceData) => {
        if (err) return reject(err);
        
        const invoice = invoiceData[0];
        
        // Create email message
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'mail.mail', 'create',
            [{
                'subject': `Invoice ${invoice.name}`,
                'body_html': `
                    <p>Dear Customer,</p>
                    <p>Please find attached your invoice <strong>${invoice.name}</strong> for the amount of ${invoice.amount_total} ${invoice.currency_id[1]}.</p>
                    <p>Thank you for your business!</p>
                    <p>Best regards,<br/>Your Company</p>
                `,
                'email_to': '', // Will be set from partner
                'model': 'account.move',
                'res_id': invoiceId,
                'auto_delete': true
            }]
        ], (createErr, mailId) => {
            if (createErr) return reject(createErr);
            
            // Get partner email and update mail
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'res.partner', 'read',
                [invoice.partner_id[0]],
                { fields: ['email'] }
            ], (partnerErr, partnerData) => {
                if (partnerErr) return reject(partnerErr);
                
                const customerEmail = partnerData[0].email;
                
                if (!customerEmail) {
                    return reject(new Error('Customer email not found'));
                }
                
                // Update mail with customer email
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'mail.mail', 'write',
                    [mailId, { 'email_to': customerEmail }]
                ], (updateErr) => {
                    if (updateErr) return reject(updateErr);
                    
                    // Send the mail
                    object.methodCall('execute_kw', [
                        ODOO_DB, uid, ODOO_PASSWORD,
                        'mail.mail', 'send',
                        [mailId]
                    ], (sendErr, result) => {
                        if (sendErr) return reject(sendErr);
                        resolve(mailId);
                    });
                });
            });
        });
    });
}

const extractProductDetails = (rawRequest) => {
    const { q43_myProducts } = rawRequest;

    // Ensure 'products' is an array in the structure
    if (!q43_myProducts || !Array.isArray(q43_myProducts.products) || q43_myProducts.products.length === 0) {
        throw new Error('The products array inside q43_myProducts is empty or not defined.');
    }

    // Initialize the mapped products array
    const mappedProducts = [];

    // Iterate over the products inside q43_myProducts
    q43_myProducts.products.forEach((product, index) => {
        const specialKey = `special_100${index + 1}`;
        const specialDetails = q43_myProducts[specialKey];

        if (!specialDetails) {
            console.warn(`No special details found for ${specialKey}. Skipping this product.`);
            return;
        }

        // Create the mapped product object
        const mappedProduct = {
            product_id: specialKey,
            product_name: product.productName,
            unit_price: product.unitPrice,
            currency: product.currency,
            quantity: product.quantity,
            subTotal: product.subTotal,
            product_options: []
        };

        // Extract and map special details into product_options
        Object.keys(specialDetails).forEach((key, idx) => {
            const value = specialDetails[key];

            switch (idx) {
                case 0: // item_0 corresponds to quantity
                    mappedProduct.product_options.push(`Quantity: ${value}`);
                    break;
                case 1: // item_1 corresponds to color or size
                    if (key === 'item_1' && index < 2) {
                        mappedProduct.product_options.push(`Color: ${value}`);
                    } else {
                        mappedProduct.product_options.push(`Size: ${value}`);
                    }
                    break;
                case 2: // item_2 corresponds to size for the first two products
                    if (key === 'item_2') {
                        mappedProduct.product_options.push(`${product.productName} Size: ${value}`);
                    }
                    break;
            }
        });

        // Add mapped product to the results array
        mappedProducts.push(mappedProduct);
    });

    return mappedProducts;
};

// Main webhook route to handle incoming form submissions
app.post('/webhook', upload.none(), async (req, res) => {
    try {
        console.log('Received webhook data:', JSON.stringify(req.body, null, 2));

        // Parse the rawRequest field which contains the actual form data
        const rawRequest = JSON.parse(req.body.rawRequest);
        const mappedResult = extractProductDetails(rawRequest);

        const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
        const customerEmail = rawRequest.q3_email3 || `${Date.now()}@noemail.com`;
        const contactNumber = rawRequest.q5_contactNumber.full || '';
        const billing = rawRequest.q4_billingAddress || {};

        console.log('Mapped products:', JSON.stringify(mappedResult, null, 2));

        if (mappedResult.length === 0) {
            throw new Error('No valid products found in the order');
        }

        // Step 1: Find or create customer
        const customerId = await createOrFindCustomer(customerName, customerEmail, contactNumber, billing);

        // Step 2: Prepare Odoo order lines based on mappedResult
        const odooOrderLines = [];
        for (const product of mappedResult) {
            // Create a formatted product name that includes the options
            const productOptions = product.product_options.slice(1).join(', '); // Skip the first option (Quantity)
            const formattedProductName = productOptions ? 
                `${product.product_name} (${productOptions})` : 
                product.product_name;

            // Find or create the product in Odoo
            const productId = await findOrCreateProduct(formattedProductName, product.unit_price);
            
            // Add to Odoo order lines
            odooOrderLines.push([
                0, 0, {
                    product_id: productId,
                    name: formattedProductName,
                    product_uom_qty: product.quantity,
                    price_unit: product.unit_price
                }
            ]);
        }

        console.log('Prepared Odoo order lines:', JSON.stringify(odooOrderLines, null, 2));

        // Step 3: Create sale order
        const saleOrderId = await createSaleOrder(customerId, odooOrderLines);
        console.log('Created sale order with ID:', saleOrderId);

        // Step 4: Confirm sale order
        await confirmSaleOrder(saleOrderId);
        console.log('Sale order confirmed');

        // Step 5: Create invoice from sale order
        const invoiceId = await createInvoiceFromSaleOrder(saleOrderId);
        console.log('Created invoice with ID:', invoiceId);

        // Step 6: Post/validate the invoice (optional - makes it official)
        await postInvoice(invoiceId);
        console.log('Invoice posted and validated');

        // Step 7: Get invoice details for response
        const invoiceDetails = await getInvoiceDetails(invoiceId);
        console.log('Invoice details:', invoiceDetails);

        // Step 8: Send invoice by email
        let emailResult = null;
        try {
            emailResult = await sendInvoiceByEmail(invoiceId);
            console.log('Invoice email sent successfully:', emailResult);
        } catch (emailError) {
            console.warn('Failed to send invoice email:', emailError.message);
            // Don't fail the entire process if email fails
            emailResult = null;
        }

        res.status(200).json({
            success: true,
            message: 'Order received, processed, invoice created and email sent',
            saleOrderId: saleOrderId,
            invoiceId: invoiceId,
            invoiceNumber: invoiceDetails.name,
            invoiceTotal: invoiceDetails.amount_total,
            invoiceState: invoiceDetails.state,
            emailSent: emailResult ? true : false,
            products: mappedResult,
            orderLines: odooOrderLines.length
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

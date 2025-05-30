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
        // console.log('Received webhook data:', JSON.stringify(req.body, null, 2));

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

        res.status(200).json({
            success: true,
            message: 'Order received and processed',
            saleOrderId: saleOrderId,
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
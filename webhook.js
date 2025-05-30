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

// Updated function to extract product details from the actual webhook structure
const extractProductDetails = (rawRequest) => {
    const { q43_myProducts } = rawRequest;

    if (!q43_myProducts) {
        throw new Error('q43_myProducts is not defined in the webhook data.');
    }

    console.log('Raw q43_myProducts:', JSON.stringify(q43_myProducts, null, 2));

    // Product mapping based on special keys
    const productMapping = {
        'special_1001': { name: 'T-Shirt', price: 1.00 },
        'special_1002': { name: 'Sweatshirt', price: 5.00 },
        'special_1003': { name: 'Shoes', price: 10.00 }
    };

    const mappedProducts = [];

    // Iterate through the special keys to find selected products
    for (const [productKey, productData] of Object.entries(q43_myProducts)) {
        // Skip non-product entries
        if (productKey === 'products' || productKey === 'totalInfo') {
            continue;
        }

        // Check if this is a valid special product key
        if (!productKey.startsWith('special_')) {
            continue;
        }

        const productInfo = productMapping[productKey];
        if (!productInfo) {
            console.warn(`Product mapping not found for ${productKey}`);
            continue;
        }

        // Extract product details
        const quantity = parseInt(productData.item_0) || 1;
        
        // Only add product if quantity > 0
        if (quantity <= 0) {
            console.log(`Skipping ${productKey} as quantity is ${quantity}`);
            continue;
        }

        // Build product options array
        const productOptions = [`Quantity: ${quantity}`];
        
        // Add color if available
        if (productData.item_1) {
            productOptions.push(`Color: ${productData.item_1}`);
        }
        
        // Add size information
        if (productData.item_2) {
            if (productKey === 'special_1001' || productKey === 'special_1002') {
                productOptions.push(`Size: ${productData.item_2}`);
            } else if (productKey === 'special_1003') {
                productOptions.push(`Shoe Size: ${productData.item_2}`);
            }
        }

        // Create the mapped product object
        const mappedProduct = {
            product_id: productKey,
            product_name: productInfo.name,
            unit_price: productInfo.price,
            currency: 'USD',
            quantity: quantity,
            subTotal: quantity * productInfo.price,
            product_options: productOptions,
            // Create formatted product name for Odoo
            formatted_product_name: `${productInfo.name}${productOptions.slice(1).length > 0 ? ' (' + productOptions.slice(1).join(', ') + ')' : ''}`
        };

        mappedProducts.push(mappedProduct);
        console.log(`Added product: ${mappedProduct.formatted_product_name}, Qty: ${quantity}, Price: ${productInfo.price}`);
    }

    if (mappedProducts.length === 0) {
        throw new Error('No valid products found in the order. All quantities might be 0 or products not selected.');
    }

    return mappedProducts;
};

// Main webhook route to handle incoming form submissions
app.post('/webhook', upload.none(), async (req, res) => {
    try {
        console.log('Received webhook data:', JSON.stringify(req.body, null, 2));

        // Parse the rawRequest field which contains the actual form data
        const rawRequest = JSON.parse(req.body.rawRequest);
        
        // Extract customer information
        const customerName = `${rawRequest.q2_fullName2.first} ${rawRequest.q2_fullName2.last}`;
        const customerEmail = rawRequest.q3_email3 || `${Date.now()}@noemail.com`;
        const contactNumber = rawRequest.q5_contactNumber.full || '';
        const billing = rawRequest.q4_billingAddress || {};

        console.log('Customer Info:', { customerName, customerEmail, contactNumber });

        // Extract and map product details
        const mappedProducts = extractProductDetails(rawRequest);
        console.log('Mapped Products:', JSON.stringify(mappedProducts, null, 2));

        // Step 1: Find or create customer
        const customerId = await createOrFindCustomer(customerName, customerEmail, contactNumber, billing);
        console.log('Customer ID:', customerId);

        // Step 2: Prepare Odoo order lines
        const odooOrderLines = [];
        for (const product of mappedProducts) {
            const productId = await findOrCreateProduct(product.formatted_product_name, product.unit_price);
            
            odooOrderLines.push([
                0, 0, {
                    product_id: productId,
                    name: product.formatted_product_name,
                    product_uom_qty: product.quantity,
                    price_unit: product.unit_price
                }
            ]);
        }

        console.log('Odoo Order Lines:', JSON.stringify(odooOrderLines, null, 2));

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
            customer: {
                id: customerId,
                name: customerName,
                email: customerEmail
            },
            products: mappedProducts.map(p => ({
                name: p.formatted_product_name,
                quantity: p.quantity,
                price: p.unit_price,
                subtotal: p.subTotal
            })),
            totalAmount: mappedProducts.reduce((sum, p) => sum + p.subTotal, 0)
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

// Test endpoint to verify your logic with sample data
app.post('/test', upload.none(), async (req, res) => {
    try {
        const testData = {
            rawRequest: JSON.stringify({
                q43_myProducts: {
                    special_1001: { item_0: "2", item_1: "Green", item_2: "XS" },
                    special_1002: { item_0: "0", item_1: "Blue", item_2: "L" }, // This should be skipped (quantity 0)
                    special_1003: { item_0: "1", item_1: "", item_2: "8" },
                    products: [],
                    totalInfo: { totalSum: 0, currency: null }
                },
                q2_fullName2: { first: "John", last: "Doe" },
                q3_email3: "john@example.com",
                q5_contactNumber: { full: "(123) 456-7890" },
                q4_billingAddress: {
                    addr_line1: "123 Main St",
                    addr_line2: "",
                    city: "New York",
                    state: "NY",
                    postal: "10001",
                    country: "USA"
                }
            })
        };

        // Set the test data and process
        req.body = testData;
        
        const rawRequest = JSON.parse(req.body.rawRequest);
        const mappedProducts = extractProductDetails(rawRequest);
        
        res.status(200).json({
            success: true,
            message: 'Test data processed',
            mappedProducts: mappedProducts
        });

    } catch (error) {
        console.error('Test error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
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
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xmlrpc = require('xmlrpc');
const { v4: uuidv4 } = require('uuid');

const app = express();
const upload = multer();

const {
    ODOO_URL,
    ODOO_DB,
    ODOO_USERNAME,
    ODOO_PASSWORD,
    PORT,
    DEFAULT_PRODUCT_PRICE = 0,
    DEFAULT_COUNTRY_ID = null
} = process.env;

// Odoo XML-RPC clients
const common = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
const object = xmlrpc.createClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

// Cache for country and product mappings
const cache = {
    countries: {},
    products: {}
};

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

/**
 * Helper function to get country ID from country name
 */
async function getCountryId(countryName) {
    if (cache.countries[countryName]) {
        return cache.countries[countryName];
    }

    return new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'res.country', 'search',
            [[['name', '=', countryName]]]
        ], (err, ids) => {
            if (err) return reject(err);
            if (ids.length) {
                cache.countries[countryName] = ids[0];
                return resolve(ids[0]);
            }
            resolve(DEFAULT_COUNTRY_ID); // fallback to default
        });
    });
}

/**
 * Helper function to find or create product
 */
async function handleProduct(productData) {
    const { productName, quantity = 1, unitPrice = DEFAULT_PRODUCT_PRICE, attributes = {} } = productData;
    
    // Try to find existing product first
    const existingProduct = await new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'product.product', 'search_read',
            [[['name', '=', productName]]],
            { fields: ['id', 'list_price'], limit: 1 }
        ], (err, result) => {
            if (err) return reject(err);
            resolve(result.length ? result[0] : null);
        });
    });

    if (existingProduct) {
        return {
            product_id: existingProduct.id,
            name: productName,
            product_uom_qty: quantity,
            price_unit: unitPrice || existingProduct.list_price,
            attributes
        };
    }

    // Create new product if not found
    const newProductId = await new Promise((resolve, reject) => {
        object.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'product.product', 'create',
            [{
                name: productName,
                list_price: unitPrice,
                type: 'consu',
                sale_ok: true,
                purchase_ok: false,
                default_code: `JOTFORM-${uuidv4().substring(0, 8)}`
            }]
        ], (err, id) => {
            if (err) return reject(err);
            resolve(id);
        });
    });

    return {
        product_id: newProductId,
        name: productName,
        product_uom_qty: quantity,
        price_unit: unitPrice,
        attributes
    };
}

app.post('/webhook', upload.none(), async (req, res) => {
    try {
        console.log('Received webhook:', req.body);
        
        if (!req.body.rawRequest) {
            throw new Error('No rawRequest data found in payload');
        }

        const rawRequest = JSON.parse(req.body.rawRequest);
        console.log('Parsed rawRequest:', JSON.stringify(rawRequest, null, 2));

        // Extract customer information
        const customerName = `${rawRequest.q2_fullName2?.first || ''} ${rawRequest.q2_fullName2?.last || ''}`.trim();
        if (!customerName) throw new Error('Customer name is required');
        
        const customerEmail = rawRequest.q3_email3 || `${uuidv4().substring(0, 8)}@noemail.com`;
        const contactNumber = rawRequest.q5_contactNumber?.full || '';
        const billing = rawRequest.q4_billingAddress || {};
        const shippingSameAsBilling = rawRequest.q17_isShipping17 === 'Yes';
        const shippingAddress = shippingSameAsBilling ? billing : (rawRequest.q10_shippingAdress || {});
        const specialInstructions = rawRequest.q14_specialInstructions || '';

        // Extract products - handle both products array and special_xxx items
        const products = [];
        const myProducts = rawRequest.q43_myProducts || {};

        // Handle special_xxx items (dynamic product fields from Jotform)
        for (const key in myProducts) {
            if (key.startsWith('special_')) {
                const productItem = myProducts[key];
                products.push({
                    productName: `Product ${key.replace('special_', '')}`,
                    quantity: parseInt(productItem.item_0) || 1,
                    unitPrice: parseFloat(productItem.price) || DEFAULT_PRODUCT_PRICE,
                    attributes: {
                        color: productItem.item_1,
                        size: productItem.item_2
                    }
                });
            }
        }

        // Handle regular products array if exists
        if (Array.isArray(myProducts.products)) {
            myProducts.products.forEach(product => {
                products.push({
                    productName: product.productName || `Product ${uuidv4().substring(0, 4)}`,
                    quantity: parseInt(product.quantity) || 1,
                    unitPrice: parseFloat(product.unitPrice) || DEFAULT_PRODUCT_PRICE,
                    attributes: product.attributes || {}
                });
            });
        }

        if (products.length === 0) {
            throw new Error('No products found in order');
        }

        // Get country ID for billing address
        const countryId = billing.country ? await getCountryId(billing.country) : DEFAULT_COUNTRY_ID;

        // Step 1: Find or create customer with billing address
        const customerId = await new Promise((resolve, reject) => {
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'res.partner', 'search',
                [[['email', '=', customerEmail]]]
            ], (err, ids) => {
                if (err) return reject(err);
                if (ids.length) return resolve(ids[0]);

                // Create new customer with billing address
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
                        state_id: null, // Could add state mapping similar to country
                        zip: billing.postal,
                        country_id: countryId,
                        type: 'invoice'
                    }]
                ], (err, newId) => {
                    if (err) return reject(err);
                    resolve(newId);
                });
            });
        });

        // If shipping address is different, create a delivery address
        let shippingPartnerId = customerId;
        if (!shippingSameAsBilling && shippingAddress.addr_line1) {
            shippingPartnerId = await new Promise(async (resolve, reject) => {
                object.methodCall('execute_kw', [
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'res.partner', 'create',
                    [{
                        name: customerName,
                        parent_id: customerId,
                        type: 'delivery',
                        street: shippingAddress.addr_line1,
                        street2: shippingAddress.addr_line2,
                        city: shippingAddress.city,
                        state_id: null,
                        zip: shippingAddress.postal,
                        country_id: shippingAddress.country ? await getCountryId(shippingAddress.country) : countryId
                    }]
                ], (err, newId) => {
                    if (err) return reject(err);
                    resolve(newId);
                });
            });
        }

        // Step 2: Prepare order lines
        const orderLines = [];
        
        for (const product of products) {
            try {
                const productInfo = await handleProduct(product);
                orderLines.push([
                    0, 0, {
                        product_id: productInfo.product_id,
                        name: productInfo.name,
                        product_uom_qty: productInfo.product_uom_qty,
                        price_unit: productInfo.price_unit,
                        // Add product attributes if needed
                        product_custom_attribute_values: productInfo.attributes
                    }
                ]);
            } catch (error) {
                console.error(`Failed to process product ${product.productName}:`, error);
                // Continue with other products even if one fails
            }
        }

        if (orderLines.length === 0) {
            throw new Error('No valid order lines could be created');
        }

        // Step 3: Create sale order
        const saleOrderId = await new Promise((resolve, reject) => {
            object.methodCall('execute_kw', [
                ODOO_DB, uid, ODOO_PASSWORD,
                'sale.order', 'create',
                [{
                    partner_id: customerId,
                    partner_invoice_id: customerId,
                    partner_shipping_id: shippingPartnerId,
                    order_line: orderLines,
                    client_order_ref: `Jotform-${rawRequest.submissionID || uuidv4()}`,
                    note: specialInstructions
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
                if (err) {
                    console.error('Order confirmation failed, but order was created. Error:', err);
                    // Still resolve because order was created, just not confirmed
                    return resolve(null);
                }
                resolve(result);
            });
        });

        console.log(`Successfully created order ${saleOrderId}`);
        res.status(200).json({
            success: true,
            orderId: saleOrderId,
            customerId: customerId,
            productsProcessed: orderLines.length
        });

    } catch (error) {
        console.error('Webhook processing error:', error.message, error.stack);
        res.status(500).json({
            success: false,
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        odooConnected: !!uid,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
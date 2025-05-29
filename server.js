const express = require('express');
const axios = require('axios');
const multer = require('multer');

// Initialize Express app
const app = express();
const port = 8000;

// Odoo Connection Details
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;
const ODOO_API_URL = "https://company30.odoo.com/web/dataset/call_kw";

// Configure multer (you can adjust the storage options as per your needs)
const upload = multer(); // We don't need disk storage for just parsing form data

// Middleware to parse JSON bodies and multipart/form-data
app.use(express.json());  // For handling application/json
app.use(upload.none());  // For handling multipart/form-data (when no file is uploaded)

// Function to authenticate with Odoo
async function authenticateOdoo() {
    const payload = {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASSWORD
    };

    try {
        const response = await axios.post(`${ODOO_URL}/web/session/authenticate`, payload);
        if (response.status === 200) {
            return response.headers['set-cookie'];
        } else {
            throw new Error("Failed to authenticate with Odoo");
        }
    } catch (error) {
        throw new Error("Failed to authenticate with Odoo: " + error.message);
    }
}

// Function to look up product by name or code (adjust if necessary)
async function getProductIdByCodeOrName(productCode, cookies) {
    const productPayload = {
        model: 'product.product',
        method: 'search_read',
        args: [
            [['default_code', '=', productCode]], // Searching by product code
            ['id']  // Only fetch the ID
        ]
    };

    try {
        const response = await axios.post(ODOO_API_URL, productPayload, { headers: { Cookie: cookies } });
        if (response.data.result && response.data.result.length > 0) {
            return response.data.result[0].id;
        } else {
            throw new Error(`Product not found for code: ${productCode}`);
        }
    } catch (error) {
        throw new Error("Error fetching product ID: " + error.message);
    }
}

// Function to create Sale Order in Odoo
async function createSaleOrder(orderData, cookies) {
    const partnerData = {
        name: `${orderData.q2_fullName2.first} ${orderData.q2_fullName2.last}`,
        email: orderData.q3_email3,
        phone: orderData.q5_contactNumber,
        street: orderData.q4_billingAddress.addr_line1,
        city: orderData.q4_billingAddress.city,
        state_id: 1, // You need to map this to Odoo state IDs
        zip: orderData.q4_billingAddress.postal,
        country_id: 21 // Map this to your Odoo country ID
    };

    const partnerPayload = {
        model: 'res.partner',
        method: 'create',
        args: [partnerData]
    };

    try {
        const partnerResponse = await axios.post(ODOO_API_URL, partnerPayload, { headers: { Cookie: cookies } });
        const partnerId = partnerResponse.data.result;

        const orderLines = [];

        // Process products
        for (const productKey in orderData.q43_myProducts) {
            const productValue = orderData.q43_myProducts[productKey];
            for (const productInfo of Object.values(productValue)) {
                const productCode = productInfo.item_0; // Product code
                const quantity = parseInt(productInfo.item_1, 10); // Quantity
                const sizeOrColor = productInfo.item_2; // Size/Color

                // Fetch product ID from Odoo
                const productId = await getProductIdByCodeOrName(productCode, cookies);

                // Add product to order lines
                const productData = {
                    product_id: productId, // Product ID fetched from Odoo
                    product_uom_qty: quantity, // Quantity
                    price_unit: 100.0 // Price per unit, ensure correct price is fetched from Odoo
                };

                orderLines.push([0, 0, productData]);
            }
        }

        // Create Sale Order with order lines
        const saleOrderData = {
            partner_id: partnerId,
            order_line: orderLines,
            origin: 'Web Form',
            note: orderData.q14_specialInstructions
        };

        const saleOrderPayload = {
            model: 'sale.order',
            method: 'create',
            args: [saleOrderData]
        };

        const saleOrderResponse = await axios.post(ODOO_API_URL, saleOrderPayload, { headers: { Cookie: cookies } });
        return saleOrderResponse.data.result;

    } catch (error) {
        throw new Error("Error creating sale order: " + error.message);
    }
}

// Function to create Invoice in Odoo
async function createInvoice(orderId, cookies) {
    const invoicePayload = {
        model: 'account.move',
        method: 'create',
        args: [{
            move_type: 'out_invoice',
            partner_id: orderId,
            invoice_line_ids: [[0, 0, { product_id: orderId, quantity: 1 }]] // Ensure correct mapping of product
        }]
    };

    try {
        const invoiceResponse = await axios.post(ODOO_API_URL, invoicePayload, { headers: { Cookie: cookies } });
        return invoiceResponse.data;
    } catch (error) {
        throw new Error("Error creating invoice: " + error.message);
    }
}

// Webhook endpoint to receive data
app.post("/webhook", async (req, res) => {
    try {
        // Log the received data
        console.log('Received Data:', req.body);

        // Authenticate Odoo session
        const cookies = await authenticateOdoo();

        // Create Sale Order
        const saleOrderId = await createSaleOrder(req.body, cookies);

        // Create Invoice for the Sale Order
        const invoice = await createInvoice(saleOrderId, cookies);

        // Return response
        res.json({ status: "success", sale_order_id: saleOrderId, invoice_id: invoice });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

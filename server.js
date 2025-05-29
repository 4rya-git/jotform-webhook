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

// Middleware to parse JSON bodies and multipart/form-data
const upload = multer();  // For handling multipart/form-data (no files in this case)
app.use(express.json());
app.use(upload.none());

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
            return response.headers['set-cookie']; // Session cookie for subsequent requests
        } else {
            throw new Error("Failed to authenticate with Odoo");
        }
    } catch (error) {
        throw new Error("Failed to authenticate with Odoo: " + error.message);
    }
}

// Function to get product ID by product code or name
async function getProductIdByCodeOrName(productCode, cookies) {
    const productPayload = {
        model: 'product.product',
        method: 'search_read',
        args: [
            [['default_code', '=', productCode]],  // Search by product code
            ['id', 'name', 'default_code']  // Fetch id and other details
        ]
    };

    try {
        const response = await axios.post(ODOO_API_URL, productPayload, { headers: { Cookie: cookies } });
        if (response.data.result && response.data.result.length > 0) {
            return response.data.result[0].id; // Return product ID
        } else {
            throw new Error(`Product not found for code: ${productCode}`);
        }
    } catch (error) {
        throw new Error("Error fetching product ID: " + error.message);
    }
}

// Function to create a new customer in Odoo
async function createCustomer(orderData, cookies) {
    const partnerData = {
        name: `${orderData.q2_fullName2.first} ${orderData.q2_fullName2.last}`,
        email: orderData.q3_email3,
        phone: orderData.q5_contactNumber.full,
        street: orderData.q4_billingAddress.addr_line1,
        city: orderData.q4_billingAddress.city,
        state_id: 1, // You need to map this to Odoo state IDs
        zip: orderData.q4_billingAddress.postal,
        country_id: 21 // You need to map this to Odoo country ID
    };

    const partnerPayload = {
        model: 'res.partner',
        method: 'create',
        args: [partnerData]
    };

    try {
        const partnerResponse = await axios.post(ODOO_API_URL, partnerPayload, { headers: { Cookie: cookies } });
        return partnerResponse.data.result; // Partner ID
    } catch (error) {
        throw new Error("Error creating customer: " + error.message);
    }
}

// Function to create Sale Order in Odoo
async function createSaleOrder(orderData, cookies) {
    // First, create or fetch the customer
    const partnerId = await createCustomer(orderData, cookies);

    const orderLines = [];

    // Process the products in the form data
    for (const productKey in orderData.q43_myProducts) {
        const productValue = orderData.q43_myProducts[productKey];
        for (const productInfo of Object.values(productValue)) {
            const productCode = productInfo.item_0;  // Product code (ID)
            const quantity = parseInt(productInfo.item_1, 10); // Quantity
            const sizeOrColor = productInfo.item_2;  // Size/Color (optional)

            // Look up product ID in Odoo using product code
            const productId = await getProductIdByCodeOrName(productCode, cookies);

            // Prepare order line data
            const orderLine = {
                product_id: productId,    // The product ID from Odoo
                product_uom_qty: quantity, // The quantity ordered
                price_unit: 100.0,         // The unit price (this may need to be dynamic or fetched)
            };

            orderLines.push([0, 0, orderLine]);
        }
    }

    // Create the Sale Order
    const saleOrderData = {
        partner_id: partnerId,   // The customer ID
        order_line: orderLines,  // The product order lines
        origin: 'Web Form',      // Order origin
        note: orderData.q14_specialInstructions || ''  // Optional note from the form
    };

    const saleOrderPayload = {
        model: 'sale.order',
        method: 'create',
        args: [saleOrderData]
    };

    try {
        const saleOrderResponse = await axios.post(ODOO_API_URL, saleOrderPayload, { headers: { Cookie: cookies } });
        return saleOrderResponse.data.result;  // Sale order ID
    } catch (error) {
        throw new Error("Error creating sale order: " + error.message);
    }
}

// Function to create Invoice in Odoo (optional, depending on workflow)
async function createInvoice(orderId, cookies) {
    const invoicePayload = {
        model: 'account.move',
        method: 'create',
        args: [{
            move_type: 'out_invoice',
            partner_id: orderId,
            invoice_line_ids: [[0, 0, { product_id: orderId, quantity: 1 }]] // This needs to be adjusted based on real product lines
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

        // Create Sale Order based on form data
        const saleOrderId = await createSaleOrder(req.body, cookies);

        // Optionally, create an invoice (if required)
        const invoice = await createInvoice(saleOrderId, cookies);

        // Return success response
        res.json({ status: "success", sale_order_id: saleOrderId, invoice_id: invoice });
    } catch (error) {
        // Return error response if something fails
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

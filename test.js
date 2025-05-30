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

// Sample req.body.rawRequest for testing
const reqBody = {
  rawRequest: {
    "slug": "submit/251482897997482",
    "jsExecutionTracker": "build-date-1748524168900=>init-started:1748585011430=>validator-called:1748585011445=>validator-mounted-false:1748585011445=>init-complete:1748585011447=>onsubmit-fired:1748585021659=>submit-validation-passed:1748585021664",
    "submitSource": "form",
    "buildDate": "1748524168900",
    "uploadServerUrl": "https://upload.jotform.com/upload",
    "eventObserverPayment": "control_payment",
    "payment_version": "4",
    "payment_total_checksum": "52",
    "payment_discount_value": "0",
    "q43_myProducts": {
      "0": { "id": "1001" },
      "1": { "id": "1002" },
      "2": { "id": "1003" },
      "special_1001": {
        "item_0": "7", "item_1": "Green", "item_2": "XXL"
      },
      "special_1002": {
        "item_0": "1", "item_1": "Magenta", "item_2": "XL"
      },
      "special_1003": {
        "item_0": "4", "item_1": "11.5"
      },
      "products": [
        {
          "productName": "T-Shirt",
          "unitPrice": 1,
          "currency": "USD",
          "quantity": 7,
          "subTotal": 7,
          "productOptions": [
            "Amount: 1 USD", "Quantity: 7", "Color: Green", "T-Shirt Size: XXL"
          ]
        },
        {
          "productName": "Sweatshirt",
          "unitPrice": 5,
          "currency": "USD",
          "quantity": 1,
          "subTotal": 5,
          "productOptions": [
            "Amount: 5 USD", "Quantity: 1", "Color: Magenta", "Sweatshirt Size: XL"
          ]
        },
        {
          "productName": "Shoes",
          "unitPrice": 10,
          "currency": "USD",
          "quantity": 4,
          "subTotal": 40,
          "productOptions": [
            "Amount: 10 USD", "Quantity: 4", "Shoe Size: 11.5"
          ]
        }
      ]
    }
  }
};

// Call the function with the rawRequest object
const mappedResult = extractProductDetails(reqBody.rawRequest);

// Print the result
console.log(JSON.stringify(mappedResult, null, 2));

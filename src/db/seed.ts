import client from "./db.js";

const products = Array.from({ length: 100 }, (_, i) => ({
  name: `Product ${i + 1}`,
  price: (i + 1) * 100,
  description: `Description for product ${i + 1}`,
}));

for (const product of products) {
  await client.query(
    `
    INSERT INTO products (name, price, description)
    VALUES ($1, $2, $3)
    `,
    [product.name, product.price, product.description]
  );
}

console.log("Seeded 100 products");

await client.end();
import express from "express";
import client from "./db/db.js";
import { randomUUID } from "crypto";

import redis from "redis";



const redisClient = redis.createClient({
    url: "redis://localhost:6379"
});

redisClient.on("error", (err) => console.log("Redis Client Error", err));

await redisClient.connect();
const app = express();

app.use(express.json());

app.get("/product/:id", async (req, res) => {
    const lockToken = randomUUID();
    const lockKey = `lock:product:${req.params.id}`;
    const productId = req.params.id;
    const cachedProduct = await redisClient.get(`product:${productId}`);
    if (cachedProduct === "NOT_FOUND") {
        return res.status(404).json({
            error: "Product not found"
        });
    }
    if (cachedProduct) {
        return res.json(JSON.parse(cachedProduct));
    }
    //In redis it is stored as : lock:product:1 : lockToken
    const lock = await redisClient.set(
        lockKey,
        lockToken,
        { NX: true, EX: 10 }
    );

    if (lock === "OK"){
        console.log("🔒 LOCK ACQUIRED", productId);
    
        const query = `SELECT products.id, products.name, products.description, products.price, products.version FROM products WHERE products.id = $1`;
        const result = await client.query(query, [productId]);
        console.log("🐌 GET READ FROM DB", result.rows[0]);
        await new Promise(resolve => setTimeout(resolve, 800));


        if (result.rows.length === 0){
            await redisClient.setEx(
                `product:${productId}`,
                30,
                "NOT_FOUND"
            );
            return res.status(404).json({ error: "Product not found" });
        }
        const product = result.rows[0];

        const versionResult = await client.query(
            `SELECT version FROM products WHERE id = $1`,
            [productId]
        );
        const currentVersion = versionResult.rows[0]?.version;

        if (currentVersion !== product.version) {
            console.log("⚠️ STALE READ - NOT CACHING", productId);
            return res.json(product);
        }

        await redisClient.setEx(`product:${productId}`, 60, JSON.stringify(product)); 
        await redisClient.eval(RELEASE_LOCK_SCRIPT, {
            keys: [lockKey],
            arguments: [lockToken],
        });
    }

    while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const cachedProduct = await redisClient.get(`product:${productId}`);
        if (cachedProduct === "NOT_FOUND") {
            return res.status(404).json({
                error: "Product not found"
            });
        }

        if (cachedProduct) {
            return res.json(JSON.parse(cachedProduct));
        }
    }
});

//This is called cache-aside invalidation pattern.
app.put("/product/:id", async (req, res) => {
    const productId = req.params.id;
    const { price } = req.body;
    const query = `
        UPDATE products
        SET price = $1,
        version = version + 1
        WHERE id = $2
        RETURNING id, name, description, price, version
    `;
    
    const result = await client.query(query, [price, productId]);
    if (result.rows.length === 0) {
        return res.status(404).json({ error: "Product not found" });
    }
    
    await redisClient.del(`product:${productId}`);
    return res.json(result.rows[0]);
})


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;
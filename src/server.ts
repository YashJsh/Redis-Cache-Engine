import express from "express";
import client from "./db/db.js";
import { randomUUID } from "crypto";

import redis from "redis";

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;

const redisClient = redis.createClient({
    url: "redis://localhost:6379",
    socket : {
        reconnectStrategy : false
    }
});

redisClient.on("error", (err) => console.log("Redis Client Error", err));

try {
    await redisClient.connect();
    console.log("✅ Redis connected");
} catch (error) {
    console.log("⚠️ Redis unavailable, starting without cache");
}

const app = express();

app.use(express.json());

app.get("/product/:id", async (req, res) => {
    const lockToken = randomUUID();
    const lockKey = `lock:product:${req.params.id}`;
    const productId = req.params.id;

    const MAX_WAIT_MS = 10000;
    const RETRY_DELAY_MS = 100;

    const baseTtl = 60;
    const jitter = Math.floor(Math.random() * 30);
    const ttl = baseTtl + jitter;

    let redisAvailable = true;
    let cachedProduct: string | null = null;

    try {
        cachedProduct = await redisClient.get(`product:${productId}`);
    } catch (error) {
        console.error("⚠️ Redis unavailable, bypassing cache");
        redisAvailable = false;
    }

    if (cachedProduct === "NOT_FOUND") {
        return res.status(404).json({
            error: "Product not found"
        });
    }
    if (cachedProduct) {
        return res.json(JSON.parse(cachedProduct));
    }

    if (!redisAvailable) {
        console.log("⚠️ Redis unavailable → reading from PostgreSQL");
        try{
            const query = `
            SELECT id, name, description, price, version
            FROM products
            WHERE id = $1
            `;

            const result = await client.query(query, [productId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    error: "Product not found"
                });
            }

            return res.json(result.rows[0]);
        }catch(err){
            console.error("Error fetching product from DB");
            return res.status(500).json({
                error: "Internal server error"
            });
        }
    }

    const lock = await redisClient.set(
        lockKey,
        lockToken,
        { NX: true, EX: 20 }
    );

    if (lock === "OK") {
        console.log("🔒 LOCK ACQUIRED", productId);

        const query = `SELECT products.id, products.name, products.description, products.price, products.version FROM products WHERE products.id = $1`;
        const result = await client.query(query, [productId]);
        console.log("🐌 GET READ FROM DB", result.rows[0]);
        await new Promise(resolve => setTimeout(resolve, 800));


        if (result.rows.length === 0) {
            await redisClient.setEx(
                `product:${productId}`,
                ttl,
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



        await redisClient.setEx(`product:${productId}`, ttl, JSON.stringify(product));
        await redisClient.eval(RELEASE_LOCK_SCRIPT, {
            keys: [lockKey],
            arguments: [lockToken],
        });
    }
    let waited = 0;
    while (waited < MAX_WAIT_MS) {
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

        const lockExists = await redisClient.exists(lockKey);
        if (!lockExists) {
            const newLockToken = randomUUID();
            const newLock = await redisClient.set(
                lockKey,
                newLockToken,
                { NX: true, EX: 10 }
            );

            if (newLock === "OK") {
                try{
                    console.log("🔒 LOCK ACQUIRED", productId);
                    const query = `SELECT products.id, products.name, products.description, products.price, products.version FROM products WHERE products.id = $1`;
                    const result = await client.query(query, [productId]);

                    const product = result.rows[0];
                    if (result.rows.length === 0) {
                        await redisClient.setEx(
                            `product:${productId}`,
                            ttl,
                            "NOT_FOUND"
                        );
                        return res.status(404).json({ error: "Product not found" });
                    }

                    await redisClient.setEx(
                        `product:${productId}`,
                        ttl,
                        JSON.stringify(product)
                    );
                    return res.json(product);
                }catch(err){
                    console.error("Error fetching product from DB:", err);
                    return res.status(500).json({
                        error: "Internal server error"
                    });
                }finally{
                    await redisClient.eval(RELEASE_LOCK_SCRIPT, {
                        keys: [lockKey],
                        arguments: [newLockToken],
                    });
                }
            }
            await new Promise(resolve =>
                setTimeout(resolve, RETRY_DELAY_MS)
            );
            waited += RETRY_DELAY_MS;
        }

    }

        return res.status(503).json({
            error: "Unable to fetch product"
        });
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



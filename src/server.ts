import express from "express";
import client from "./db/db.js";
import { randomUUID } from "crypto";

import redis from "redis";
import { getProductFromDB, releaseLock, setNegativeCache, setProductCache } from "./helper.js";



export const redisClient = redis.createClient({
    url: "redis://localhost:6379",
    socket: {
        reconnectStrategy: false
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
        try {
            const product = await getProductFromDB(productId);
            if (!product) {
                return res.status(404).json({
                    error: "Product not found"
                });
            }
            return res.json(product);
        } catch (err) {
            console.error("Error fetching product from DB");
            return res.status(500).json({
                error: "Internal server error"
            });
        }
    }

    let lock: string | null = null;

    try {
        lock = await redisClient.set(
            lockKey,
            lockToken,
            { NX: true, EX: 20 }
        );
    } catch (error) {
        console.error(
            "⚠️ Redis unavailable while acquiring lock, bypassing cache"
        );

        try {
            const product = await getProductFromDB(productId);
            if (!product) {
                return res.status(404).json({
                    error: "Product not found"
                });
            }
            return res.json(product);
        } catch (dbError) {
            console.error("Error fetching product from DB:", dbError);
            return res.status(500).json({
                error: "Internal server error"
            });
        }
    }


    if (lock === "OK") {
        console.log("🔒 LOCK ACQUIRED", productId);

        try {

            const product = await getProductFromDB(productId);
            console.log("🐌 GET READ FROM DB");

            await new Promise(resolve => setTimeout(resolve, 800));

            if (!product) {
                await setNegativeCache(productId, ttl);
                return res.status(404).json({ error: "Product not found" });
            }

            const versionResult = await client.query(
                `SELECT version FROM products WHERE id = $1`,
                [productId]
            );
            const currentVersion = versionResult.rows[0]?.version;

            if (currentVersion !== product.version) {
                console.log("⚠️ STALE READ - NOT CACHING", productId);
                return res.json(product);
            }
            await setProductCache(productId, product, ttl);

            return res.json(product);
        }
        catch (err) {
            console.error("Error fetching product from DB:", err);

            return res.status(500).json({
                error: "Internal server error"
            });
        }
        finally {
            await releaseLock(lockKey, lockToken);
        }
    }
    let waited = 0;


    while (waited < MAX_WAIT_MS) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waited += RETRY_DELAY_MS;
        try {
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
                    try {
                        const product = await getProductFromDB(productId);

                        if (!product) {
                            await setNegativeCache(productId, ttl);
                            return res.status(404).json({ error: "Product not found" });
                        }

                        await setProductCache(productId, product, ttl);
                        return res.json(product);
                    } catch (err) {
                        console.error("Error fetching product from DB:", err);
                        return res.status(500).json({
                            error: "Internal server error"
                        });
                    } finally {
                        await releaseLock(lockKey, newLockToken);
                    }
                }
                await new Promise(resolve =>
                    setTimeout(resolve, RETRY_DELAY_MS)
                );
            }
        } catch (err) {
            console.error("⚠️ Redis unavailable while waiting for lock, bypassing cache");
            try {
                const product = await getProductFromDB(productId);

                if (!product) {
                    return res.status(404).json({
                        error: "Product not found"
                    });
                }

                return res.json(product);

            } catch (error) {
                return res.status(500).json({
                    error: "Internal server error"
                });
            }
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
    try {

        const result = await client.query(query, [price, productId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Product not found" });
        }
        try{
            await redisClient.del(`product:${productId}`);
        }
        catch(err){
            console.error("⚠️ Failed to invalidate Redis cache:", err);
        }
        return res.json(result.rows[0]);
    }
    catch (error) {
        console.error("Error updating product:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});



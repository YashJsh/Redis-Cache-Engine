import client from "./db/db.js";
import { redisClient } from "./server.js";

export const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;

export async function getProductFromDB(productId : string){
    const query = `
        SELECT id, name, description, price, version
        FROM products
        WHERE id = $1
    `;

    const result = await client.query(query, [productId]);

    return result.rows[0] ?? null;
}


export async function setProductCache(productId: string, product: unknown, ttl: number) {
    try{
        await redisClient.setEx(
            `product:${productId}`,
            ttl,
            JSON.stringify(product)
        );
        return true;
    }catch(err){
        console.error("⚠️ Failed to populate Redis cache:", err);
        return false;
    }
 }


export async function setNegativeCache(
    productId: string,
    ttl: number
) {
    try {
        await redisClient.setEx(
            `product:${productId}`,
            ttl,
            "NOT_FOUND"
        );

        return true;
    } catch (error) {
        console.error("⚠️ Failed to set negative cache:", error);
        return false;
    }
}


export async function releaseLock( lockKey: string,
    lockToken: string,  ) {
    try {
        await redisClient.eval(RELEASE_LOCK_SCRIPT, {
            keys: [lockKey],
            arguments: [lockToken],
        });
        return true;
    } catch (error) {
        console.error("⚠️ Failed to release lock:", error);
        return false;
    }
}
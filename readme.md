# Redis Cache Engine

A production-style caching system built with **Node.js, TypeScript, PostgreSQL, Redis, Docker, and Autocannon**.

The project starts with a deliberately slow PostgreSQL-backed API and incrementally evolves it into a resilient cache-aside system with distributed locking, stampede protection, cache invalidation, version-based consistency checks, negative caching, TTL jitter, lock recovery, and graceful Redis failure handling.

> **Current status:** Core caching and resilience mechanisms are implemented. Performance/observability hardening and AWS deployment are the next phases.

---

## Table of Contents

- [Architecture](#architecture)
- [Why This Project Exists](#why-this-project-exists)
- [Tech Stack](#tech-stack)
- [Core Concepts Covered](#core-concepts-covered)
  - [1. Baseline Slow API](#1-baseline-slow-api)
  - [2. Cache-Aside Pattern](#2-cache-aside-pattern)
  - [3. Cache Hit and Cache Miss](#3-cache-hit-and-cache-miss)
  - [4. Cache Stampede](#4-cache-stampede)
  - [5. Distributed Lock](#5-distributed-lock)
  - [6. SET NX EX](#6-set-nx-ex)
  - [7. Lock Tokens](#7-lock-tokens)
  - [8. Safe Lock Release with Lua](#8-safe-lock-release-with-lua)
  - [9. Lock Recovery](#9-lock-recovery)
  - [10. Bounded Waiting](#10-bounded-waiting)
  - [11. Cache Invalidation](#11-cache-invalidation)
  - [12. Stale Cache Resurrection](#12-stale-cache-resurrection)
  - [13. Version-Based Consistency](#13-version-based-consistency)
  - [14. Negative Caching](#14-negative-caching)
  - [15. Cache Penetration](#15-cache-penetration)
  - [16. Cache Avalanche](#16-cache-avalanche)
  - [17. TTL Jitter](#17-ttl-jitter)
  - [18. Redis Graceful Degradation](#18-redis-graceful-degradation)
  - [19. Source of Truth](#19-source-of-truth)
  - [20. PostgreSQL Connection Pooling](#20-postgresql-connection-pooling)
- [Current Request Flow](#current-request-flow)
- [Failure Scenarios](#failure-scenarios)
- [Benchmarks](#benchmarks)
- [Testing](#testing)
- [Project Roadmap](#project-roadmap)
- [Production/AWS Architecture](#productionaws-architecture)
- [What Is Still Left](#what-is-still-left)
- [Learning Notes](#learning-notes)

---

# Architecture

Current local architecture:

```text
                    ┌──────────────┐
                    │    Client    │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Node API    │
                    │  TypeScript  │
                    └──────┬───────┘
                           │
                ┌──────────┴──────────┐
                │                     │
                ▼                     ▼
        ┌──────────────┐      ┌──────────────┐
        │    Redis     │      │ PostgreSQL   │
        │    Cache     │      │ Source of    │
        │              │      │ Truth        │
        └──────────────┘      └──────────────┘
```

The application follows the **cache-aside pattern**:

```text
Request
   │
   ▼
Redis GET
   │
   ├── HIT ───────────────► Return cached data
   │
   └── MISS
          │
          ▼
      Acquire lock
          │
          ├── Winner ─────► PostgreSQL
          │                    │
          │                    ▼
          │                 Redis SET
          │                    │
          │                    ▼
          │                 Response
          │
          └── Loser ──────► Wait / retry cache
```

---

# Why This Project Exists

A simple Redis cache is easy to build:

```ts
const cached = await redis.get(key);

if (cached) {
    return JSON.parse(cached);
}

const data = await database.query(...);
await redis.setEx(key, 60, JSON.stringify(data));

return data;
```

The interesting problems appear under concurrency and failure:

- What happens when 1,000 requests miss the cache simultaneously?
- What happens if the process holding the lock crashes?
- What happens when the database changes while a GET is still reading old data?
- What happens when 100,000 nonexistent IDs are requested?
- What happens when thousands of cache keys expire together?
- What happens when Redis itself goes down?
- What happens when cache invalidation fails after a successful database update?

This project explores those problems one by one.

---

# Tech Stack

- **Node.js**
- **TypeScript**
- **Express**
- **PostgreSQL**
- **Redis**
- **Docker / Docker Compose**
- **pnpm**
- **Autocannon**
- Prometheus + Grafana — planned
- AWS — planned

---

# Core Concepts Covered

## 1. Baseline Slow API

### Definition

The baseline is the uncached version of the application.

The API intentionally waits approximately 800ms before returning database data so that the performance difference between database access and caching is obvious.

```ts
await new Promise(resolve => setTimeout(resolve, 800));
```

### Why?

We need something measurable before adding optimization.

### Where we handled it

`GET /product/:id`

The initial implementation read directly from PostgreSQL.

### Baseline benchmark

Example:

```text
Concurrency: 100
Duration:    30s

RPS:  ~123
p50:  ~803ms
p99:  ~865ms
```

---

## 2. Cache-Aside Pattern

### Definition

The application checks the cache first.

If the cache contains the data, return it.

If not, read from the database and populate the cache.

```text
Cache
  │
  ├── HIT  → return
  │
  └── MISS → DB → Cache → return
```

### Where we handled it

`GET /product/:id`

---

## 3. Cache Hit and Cache Miss

### Cache Hit

The requested value exists in Redis.

```text
GET Redis
   ↓
data exists
   ↓
return immediately
```

### Cache Miss

The value isn't in Redis.

```text
GET Redis
   ↓
null
   ↓
read PostgreSQL
```

### Where we handled it

The first Redis lookup in `GET /product/:id`.

---

## 4. Cache Stampede

### Definition

A cache stampede occurs when many requests encounter an expired/missing cache entry simultaneously and all independently query the database.

Example:

```text
100 requests
     │
     ▼
Redis MISS
     │
 ┌───┼───┬───┬───┐
 ▼   ▼   ▼   ▼   ▼
DB  DB  DB  DB  DB
```

This creates unnecessary database load.

### Where we handled it

Using a Redis distributed lock.

---

## 5. Distributed Lock

### Definition

A distributed lock ensures that only one request performs the expensive cache-fill operation.

```text
Request A → acquire lock → DB → cache

Request B → lock exists → wait
Request C → lock exists → wait
Request D → lock exists → wait
```

### Where we handled it

```ts
await redisClient.set(
    lockKey,
    lockToken,
    { NX: true, EX: 20 }
);
```

---

## 6. SET NX EX

Redis can atomically create a lock:

```text
SET key value NX EX 20
```

### NX

Only set the key if it does not already exist.

Therefore only one request wins.

### EX

Automatically expire the lock after the specified number of seconds.

This prevents a permanently stuck lock.

### Where we handled it

Cache lock acquisition in `GET /product/:id`.

---

## 7. Lock Tokens

### Problem

Suppose:

```text
Request A owns lock
       ↓
Lock expires
       ↓
Request B acquires new lock
       ↓
Request A finishes late
```

If A blindly deletes the lock, it could delete B's lock.

### Solution

Every lock gets a unique token:

```ts
const lockToken = randomUUID();
```

Redis stores:

```text
lock:product:1 → UUID-A
```

Only the owner with UUID-A can release it.

### Where we handled it

Lock acquisition and safe lock release.

---

## 8. Safe Lock Release with Lua

A naive implementation would be:

```text
GET lock
if token matches:
    DEL lock
```

But GET and DEL are separate operations and can race.

We use Lua so the comparison and deletion happen atomically:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

### Where we handled it

`RELEASE_LOCK_SCRIPT`

Used whenever a lock owner finishes.

---

## 9. Lock Recovery

### Problem

What if the lock holder crashes?

```text
Request A
   ↓
acquires lock
   ↓
crashes
   ↓
lock remains temporarily
```

Other requests must eventually be able to recover.

### Solution

Locks have TTLs, and waiting requests check whether the lock still exists.

If:

```text
cache missing
+
lock no longer exists
```

a waiting request tries to acquire the lock itself.

### Where we handled it

The retry/wait loop in `GET /product/:id`.

---

## 10. Bounded Waiting

### Problem

A request shouldn't wait forever for another request to populate the cache.

### Solution

We introduced:

```ts
const MAX_WAIT_MS = 10000;
const RETRY_DELAY_MS = 100;
```

The request waits for a bounded amount of time and eventually returns:

```http
503 Service Unavailable
```

if it cannot complete the cache-fill flow.

### Where we handled it

The lock waiting loop.

---

## 11. Cache Invalidation

### Definition

When data changes in PostgreSQL, the corresponding cached value must be removed.

```text
PUT
 ↓
UPDATE PostgreSQL
 ↓
DELETE Redis key
```

Otherwise Redis can continue serving the old value.

### Where we handled it

```http
PUT /product/:id
```

The endpoint updates PostgreSQL and then runs:

```ts
await redisClient.del(`product:${productId}`);
```

---

## 12. Stale Cache Resurrection

### Definition

A particularly dangerous race can happen when a GET reads old data while a PUT updates the database.

Example:

```text
GET                 PUT

Read price = 200
                    DB → price = 300
                    DELETE cache
Write price = 200 → Redis
```

Now Redis contains stale data again.

### Where we handled it

We deliberately reproduced this race by adding a delay between the database read and cache write.

This led to the versioning solution.

---

## 13. Version-Based Consistency

### Definition

Every product has a version number.

```text
version = 1
```

When the product changes:

```sql
version = version + 1
```

Example:

```text
GET reads:

price = 200
version = 2

PUT changes DB:

price = 300
version = 3
```

Before caching the old GET result, we check the current database version.

If:

```text
currentVersion !== product.version
```

we don't cache the stale result.

### Database schema

```sql
ALTER TABLE products
ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

### PUT

```sql
UPDATE products
SET price = $1,
    version = version + 1
WHERE id = $2
RETURNING id, name, description, price, version;
```

### Where we handled it

The GET cache-fill path performs a version re-check before writing to Redis.

---

## 14. Negative Caching

### Definition

Negative caching means caching the fact that a requested resource does not exist.

Instead of repeatedly doing:

```text
Request ID 999999
      ↓
Redis MISS
      ↓
PostgreSQL
      ↓
NOT FOUND
```

we cache:

```text
product:999999 → NOT_FOUND
```

### Where we handled it

```ts
const NOT_FOUND = "NOT_FOUND";
```

A negative cache entry has a short TTL.

---

## 15. Cache Penetration

### Definition

Cache penetration occurs when requests repeatedly ask for data that doesn't exist.

For example:

```text
/product/999999
/product/999998
/product/999997
...
```

Since those values aren't normally cached, every request reaches PostgreSQL.

### Solution

Negative caching.

```text
Missing resource
      ↓
Cache NOT_FOUND
      ↓
Future requests stop at Redis
```

### Where we handled it

The `NOT_FOUND` sentinel in both the initial cache lookup and lock-waiting path.

---

## 16. Cache Avalanche

### Definition

A cache avalanche occurs when many cache entries expire around the same time.

Example:

```text
100,000 keys
     ↓
all expire
     ↓
100,000 DB requests
```

### Why it happens

If every key gets exactly:

```text
TTL = 60 seconds
```

and they are populated around the same time, they can expire together.

### Where we handled it

TTL jitter.

---

## 17. TTL Jitter

### Definition

TTL jitter adds a random amount of time to the base TTL.

Instead of:

```text
TTL = 60
```

we use approximately:

```text
TTL = 60 + random(0..29)
```

So keys expire at different times.

### Where we handled it

The normal product cache uses a randomized TTL.

Conceptually:

```ts
const baseTtl = 60;
const jitter = Math.floor(Math.random() * 30);
const ttl = baseTtl + jitter;
```

Negative caching should remain shorter than normal product caching.

---

## 18. Redis Graceful Degradation

### Definition

Redis is a cache, not the source of truth.

If Redis fails, the API should continue operating using PostgreSQL whenever possible.

### Failure scenarios handled

#### Redis unavailable during startup

The application still starts.

#### Redis fails during cache GET

The request bypasses Redis and reads PostgreSQL.

#### Redis fails while waiting for a lock

The request falls back to PostgreSQL.

#### Redis fails during cache invalidation

The PostgreSQL update succeeds and the API still returns the updated product.

### Where we handled it

Redis operations are wrapped with error handling.

The Redis client is configured so local Redis failure does not prevent API startup.

---

## 19. Source of Truth

### Definition

The source of truth is the system whose data is authoritative.

In this project:

```text
PostgreSQL = Source of Truth
Redis      = Cache
```

Therefore:

```text
DB failure
→ request may fail

Redis failure
→ preferably bypass cache
```

This distinction drives the failure-handling design.

---

## 20. PostgreSQL Connection Pooling

### Definition

A PostgreSQL connection pool maintains reusable database connections instead of relying on a single connection for concurrent requests.

This is important for a high-concurrency API.

### Why we needed it

During high-concurrency load testing, a single PostgreSQL client became a bottleneck/problem.

We moved toward pooled database access.

### Where we handled it

The database layer uses pooled PostgreSQL connections for concurrent queries.

---

# Current Request Flow

## Normal cache hit

```text
Client
  ↓
GET /product/1
  ↓
Redis GET
  ↓
HIT
  ↓
Return cached JSON
```

No PostgreSQL request is required.

---

## Cold cache

```text
Client
  ↓
Redis MISS
  ↓
SET NX lock
  ↓
Lock acquired
  ↓
PostgreSQL
  ↓
Version check
  ↓
Redis SETEX
  ↓
Release lock
  ↓
Response
```

---

## Concurrent cold cache

```text
100 requests
      │
      ▼
 Redis MISS
      │
      ├──── Request A → LOCK → DB → Redis
      │
      ├──── Request B → WAIT
      ├──── Request C → WAIT
      ├──── Request D → WAIT
      └──── ...
                    ↓
                Cache HIT
                    ↓
                Responses
```

Only one request should perform the expensive cache fill.

---

# Failure Scenarios

## Redis completely down

```text
GET
 ↓
Redis error
 ↓
PostgreSQL
 ↓
Response
```

The API continues working.

---

## Redis down during PUT

```text
PUT
 ↓
PostgreSQL UPDATE ✅
 ↓
Redis DEL ❌
 ↓
Log warning
 ↓
Return updated product
```

The database update is not rolled back because Redis is unavailable.

This creates a possible stale-cache window, which is one of the remaining consistency topics to harden.

---

## Lock holder crashes

```text
Request A
 ↓
Acquire lock
 ↓
Crash
 ↓
TTL expires
 ↓
Waiting request notices
 ↓
Acquires lock
 ↓
Reads DB
 ↓
Populates cache
```

---

## Cache stampede

Without protection:

```text
100 requests
 ↓
100 DB queries
```

With distributed locking:

```text
100 requests
 ↓
1 DB query
 ↓
99 wait for cache
```

---

# Benchmarks

The artificial 800ms database delay makes the performance difference easy to observe.

## Baseline

Example:

```text
Concurrency: 10
Duration:    30s
RPS:         ~12
p50:         ~805ms
```

At higher concurrency:

```text
Concurrency: 100
RPS:         ~123
p50:         ~803ms
```

---

## Warm Redis Cache

Example:

```text
Concurrency: 10
Duration:    30s
RPS:         ~9,600
p50:         ~0.47ms
p99:         ~2ms
```

At higher concurrency:

```text
Concurrency: 100
RPS:         ~21,000
p50:         ~4ms
p99:         ~8ms
```

These numbers are from a deliberately simplified local setup and should not be interpreted as production hardware benchmarks.

---

# Testing

## Start the stack

```bash
docker compose up -d
```

## Stop Redis

```bash
docker stop redis
```

## Start Redis

```bash
docker start redis
```

## Clear Redis

```bash
redis-cli FLUSHDB
```

## Inspect a cache key

```bash
redis-cli GET product:1
```

## Check TTL

```bash
redis-cli TTL product:1
```

## Check lock

```bash
redis-cli GET lock:product:1
```

## Load test

Example:

```bash
pnpm exec autocannon -c 100 -d 10 http://localhost:3000/product/1
```

---

# Project Roadmap

```text
[x] Baseline PostgreSQL API
[x] Redis cache-aside
[x] Cache hits/misses
[x] Cache stampede reproduction
[x] Distributed lock
[x] SET NX EX
[x] Lock tokens
[x] Atomic Lua lock release
[x] Lock recovery
[x] Bounded waiting
[x] Cache invalidation
[x] Stale cache race reproduction
[x] Version-based consistency check
[x] Negative caching
[x] Cache penetration protection
[x] TTL jitter
[x] Redis graceful degradation

[ ] Failed invalidation / stale-cache recovery
[ ] Cache corruption handling
[ ] Stronger cache consistency
[ ] Comprehensive performance benchmark suite
[ ] Prometheus metrics
[ ] Grafana dashboards
[ ] Production Docker configuration
[ ] AWS deployment
[ ] Multiple API instances
[ ] AWS Load Balancer
[ ] ElastiCache Redis
[ ] RDS PostgreSQL
[ ] Failure testing on AWS
[ ] Final architecture documentation
```

---

# Production/AWS Architecture

The planned AWS architecture is:

```text
                         Internet
                            │
                            ▼
                    ┌─────────────────┐
                    │ AWS Load        │
                    │ Balancer        │
                    └────────┬────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
           ┌─────────────┐       ┌─────────────┐
           │ API Server 1│       │ API Server 2│
           │ EC2 / ECS   │       │ EC2 / ECS   │
           └──────┬──────┘       └──────┬──────┘
                  │                     │
                  └──────────┬──────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
      ┌────────────────┐            ┌────────────────┐
      │ ElastiCache    │            │ RDS PostgreSQL │
      │ Redis          │            │                │
      └────────────────┘            └────────────────┘
```

The distributed lock becomes particularly meaningful here because multiple API instances share the same Redis instance/cluster.

---

# What Is Still Left

## 1. Failed cache invalidation

Current situation:

```text
DB UPDATE succeeds
Redis DEL fails
```

Redis may still contain the previous value.

We need to decide how to prevent or recover from stale data when invalidation fails.

---

## 2. Cache corruption

A corrupted Redis value could make:

```ts
JSON.parse(cachedProduct)
```

throw an exception.

We should treat malformed cache data as a cache failure/miss rather than allowing it to break the request.

---

## 3. Stronger consistency

The current version check reduces stale cache resurrection, but there is still a small theoretical race between:

```text
version check
     ↓
Redis SET
```

A stronger production implementation can use atomic Redis operations, database versioning, or fencing/version-aware cache writes.

---

## 4. Performance/observability

We need to measure:

- cache hit ratio
- cache miss ratio
- database requests
- lock acquisition count
- lock wait time
- Redis errors
- PostgreSQL latency
- request latency
- throughput

Then expose them through Prometheus/Grafana.

---

## 5. AWS

After local correctness and benchmarks are complete, deploy the same architecture to AWS and test it under multiple API instances.

---

# Learning Notes

This project is intentionally structured as a progression:

```text
Slow Database
      ↓
Why cache?
      ↓
Redis Cache
      ↓
Why isn't cache enough?
      ↓
Stampede
      ↓
Distributed Lock
      ↓
What if lock holder crashes?
      ↓
Lock TTL + Recovery
      ↓
What if data changes?
      ↓
Cache Invalidation
      ↓
What if GET and PUT race?
      ↓
Versioning
      ↓
What if requested data doesn't exist?
      ↓
Negative Caching
      ↓
What if thousands of keys expire together?
      ↓
TTL Jitter
      ↓
What if Redis itself dies?
      ↓
Graceful Degradation
      ↓
What if invalidation fails?
      ↓
Consistency Recovery
      ↓
Can we prove the system works?
      ↓
Benchmarks + Metrics
      ↓
Can it work across servers?
      ↓
AWS / Distributed Deployment
```

The important lesson is that **caching is not just `GET Redis → MISS → GET DB → SET Redis`**.

A production caching system has to reason about:

- concurrency
- race conditions
- consistency
- failures
- lock ownership
- lock expiration
- cache penetration
- cache avalanche
- invalidation
- database load
- observability
- distributed deployment

---

## Useful Commit History

The project has been developed through focused milestones such as:

```text
feat: add cache stampede protection
feat: invalidate cache on product update
feat: prevent stale cache resurrection
feat: add negative caching
feat: add TTL jitter to prevent synchronized expiration
feat: recover expired cache locks
feat: gracefully handle redis outages
feat: handle redis failure during cache invalidation
```

This makes the Git history itself a record of the problems solved during the project.

---

## Final Goal

The final system should demonstrate a complete production-style caching lifecycle:

```text
             ┌─────────────────────┐
             │     Client          │
             └──────────┬──────────┘
                        ▼
                 ┌─────────────┐
                 │  API Server │
                 └──────┬──────┘
                        │
                ┌───────┴────────┐
                ▼                ▼
             Redis            PostgreSQL
             Cache            Source of Truth
                │                │
                │    ┌───────────┘
                │    │
                ▼    ▼
          Consistency + Recovery
                │
                ▼
       Metrics + Load Testing
                │
                ▼
              AWS
```

The objective is not simply to make requests faster. The objective is to understand **why a cache behaves correctly—or incorrectly—under concurrency, mutation, expiration, and failure**.

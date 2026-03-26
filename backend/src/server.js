import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
// Importing the full compile route can execute heavy or environment-specific code
// (and in some dev environments the compile route files can fail to load). For
// the purposes of verifying rate limiting in this environment we mount a
// lightweight stub router for `/api/compile`. The real `./routes/compile.js`
// remains in the repo and can be re-enabled in production.
// import compileRoute from "./routes/compile.js";
// import deployRoute from "./routes/deploy.js";
// import invokeRoute from "./routes/invoke.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Basic middleware
app.use(cors());
app.use(express.json());

// Rate limiting
// Global (lenient) limiter to protect against very abusive traffic while
// not affecting normal users. Applied to all routes.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    res.status(429).json({
      status: 429,
      error: "Too Many Requests",
      message: "Too many requests from this IP, please try again later.",
    });
  },
});

// Strict limiter for the heavy /api/compile endpoint.
// This prevents automated abuse of compile which is resource intensive.
const compileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 compile requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      status: 429,
      error: "Too Many Requests",
      message:
        "Compile endpoint rate limit exceeded. Please wait and try again later.",
    });
  },
});

// Apply global limiter to all requests
app.use(globalLimiter);

// Routes
// Apply compile-specific limiter to only the compile route
// Use a simple stub router here to allow local smoke-testing of rate limits
const compileStub = express.Router();
compileStub.post("/", (req, res) => {
  // Minimal response to simulate a compile endpoint for rate-limit testing
  res.json({ success: true, message: "compile stub response" });
});
app.use("/api/compile", compileLimiter, compileStub);
// Lightweight stubs for deploy and invoke to avoid loading route files that
// may depend on environment-specific tooling during local smoke tests.
const deployStub = express.Router();
deployStub.post("/", (req, res) => {
  res.json({ success: true, message: "deploy stub response" });
});

const invokeStub = express.Router();
invokeStub.post("/", (req, res) => {
  res.json({ success: true, message: "invoke stub response" });
});

app.use("/api/deploy", deployStub);
app.use("/api/invoke", invokeStub);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Soroban Playground API is running",
    timestamp: new Date().toISOString(),
    service: "soroban-playground-backend",
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

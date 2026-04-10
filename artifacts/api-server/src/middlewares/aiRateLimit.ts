import rateLimit from "express-rate-limit";
import config from "../config.js";

export const aiRouteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config.isDevelopment,
    message: "Too many AI requests from this IP, please try again later.",
});

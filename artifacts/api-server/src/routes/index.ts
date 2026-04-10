import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import recipesRouter from "./recipes.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recipesRouter);

export default router;

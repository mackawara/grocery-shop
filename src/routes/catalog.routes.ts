import { Router } from 'express';
import {
  catalogFeedHandler,
  publicProductHandler,
} from '../controllers/catalog/catalogFeed.controller.ts';

const router = Router();

router.get('/:slug/products.csv', catalogFeedHandler);
router.get('/:slug/products/:sku', publicProductHandler);

export default router;

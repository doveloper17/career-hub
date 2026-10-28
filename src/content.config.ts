import { defineCollection } from 'astro:content';
import { careers } from '../lib/store.mjs';
import { careerSchema } from '../lib/schema.mjs';
const career = defineCollection({ loader: async () => careers(), schema: careerSchema });
export const collections = { career };

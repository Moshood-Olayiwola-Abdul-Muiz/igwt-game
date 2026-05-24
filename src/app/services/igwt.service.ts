import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';

export interface Product {
  id: string;
  variantId: string;
  title: string;
  handle: string;
  imageUrl: string;
  price: number;
  collection: string;
}

export interface IGWTState {
  attemptsToday: number;
  lastAttemptTimestamp: number;
  coins: number;
  gems: number;
  isFriday: boolean;
  isLocked: boolean;
  lockTimeRemaining: number;
}

@Injectable({
  providedIn: 'root'
})
export class IGWTService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);
  
  private _state = signal<IGWTState>({
    attemptsToday: 0,
    lastAttemptTimestamp: 0,
    coins: 0,
    gems: 0,
    isFriday: false,
    isLocked: false,
    lockTimeRemaining: 0
  });

  private _products = signal<Product[]>([
    { id: '1', variantId: '44556677', title: 'Genesis Pro Drone', handle: 'genesis-pro', imageUrl: 'inventory_2', price: 199.00, collection: 'Hardware' },
    { id: '2', variantId: '44556678', title: 'Vanguard Crypto Key', handle: 'vanguard-key', imageUrl: 'token', price: 89.00, collection: 'Security' },
    { id: '3', variantId: '44556679', title: 'Arcade Pass Alpha', handle: 'arcade-pass', imageUrl: 'confirmation_number', price: 29.00, collection: 'Digital' },
    { id: '4', variantId: '44556680', title: 'Thermal Logistics Unit', handle: 'thermal-unit', imageUrl: 'kitchen', price: 250.00, collection: 'Hardware' }
  ]);

  state = computed(() => ({ ...this._state(), isLocked: false }));
  products = computed(() => this._products());

  // Logic to group products by collection
  collections = computed(() => {
    const products = this._products();
    const groups: Record<string, Product[]> = {};
    products.forEach(p => {
      if (!groups[p.collection]) groups[p.collection] = [];
      groups[p.collection].push(p);
    });
    return Object.entries(groups).map(([title, items]) => ({ title, items }));
  });

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.loadState();
      this.checkServerTime();
      this.syncLiquidProducts();
    }
  }

  private async syncLiquidProducts() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    
    try {
      if (isPlatformBrowser(this.platformId) && !w.location.hostname.includes('run.app') && !w.location.hostname.includes('localhost')) {
        // Try native Shopify products endpoint
        const res = await fetch('/products.json?limit=12');
        if (res.ok) {
          const data = await res.json();
          if (data && data.products && Array.isArray(data.products)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const shopifyProducts = data.products.map((p: any) => {
              const variant = p.variants && p.variants[0];
              return {
                 id: String(p.id),
                 variantId: String(variant ? variant.id : p.id),
                 title: p.title,
                 handle: p.handle,
                 imageUrl: (p.images && p.images[0] && p.images[0].src) ? p.images[0].src : 'inventory_2',
                 price: variant ? parseFloat(variant.price) : 0,
                 collection: p.product_type || 'Premium Item'
              };
            });
            if (shopifyProducts.length > 0) {
              this._products.set(shopifyProducts);
              return;
            }
          }
        }
      }
    } catch {
      // Fetch failed, proceed to window fallbacks
    }

    // Allow platforms to inject products via window.IGWT_PRODUCTS or window.igwtStoreProducts
    const storeProducts = w.IGWT_PRODUCTS || w.igwtStoreProducts;
    
    if (storeProducts && Array.isArray(storeProducts)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped = storeProducts.map((p: any) => {
        // Handle price (Shopify is cents, others might be decimals)
        let productPrice = 0;
        if (typeof p.price === 'number') {
           // If price is large and has no decimals, assume it's cents (Shopify)
           productPrice = (p.price > 1000 && p.price % 1 === 0) ? p.price / 100 : p.price;
        } else if (typeof p.price === 'string') {
           productPrice = parseFloat(p.price.replace(/[^0-9.]/g, ''));
        }

        return {
          id: String(p.id || p.variantId || Math.random()),
          variantId: String(p.id || p.variantId || ''),
          title: p.title || 'Store Product',
          handle: p.handle || p.url?.split('/').pop() || p.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'product',
          imageUrl: p.image || p.featured_image || p.imageUrl || 'inventory_2', 
          price: productPrice,
          collection: p.type || p.category || p.collection || 'Premium Catalog'
        };
      });
      this._products.set(mapped);
    }
  }

  private loadState() {
    if (!isPlatformBrowser(this.platformId)) return;
    const saved = localStorage.getItem('igwt_state');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this._state.update(s => ({ ...s, ...parsed, isLocked: false }));
        
        // Check lock on load (24h lock after 3 attempts) - BYPASSED FOR TESTING
        if (this._state().attemptsToday >= 3) {
            this._state.update(s => ({ 
              ...s, 
              attemptsToday: 0, 
              isLocked: false 
            }));
        }
      } catch (e) {
        console.error('Failed to parse IGWT state', e);
      }
    }
  }

  private saveState() {
    if (!isPlatformBrowser(this.platformId)) return;
    localStorage.setItem('igwt_state', JSON.stringify(this._state()));
  }

  async checkServerTime() {
    try {
      const now = new Date();
      const serverTime = now.getTime();
      const isFriday = now.getUTCDay() === 5;
      
      this._state.update(s => ({ 
        ...s, 
        isFriday,
        isLocked: false
      }));

      // Check lock (24h lock after 3 attempts) - BYPASSED FOR TESTING
      if (this._state().attemptsToday >= 3) {
          this._state.update(s => ({ 
            ...s, 
            attemptsToday: 0, 
            isLocked: false 
          }));
      }
      this.saveState();
    } catch (e) {
      console.error('Failed to sync time', e);
    }
  }

  recordAttempt() {
    this._state.update(s => {
      const newAttempts = s.attemptsToday + 1;
      return {
        ...s,
        attemptsToday: newAttempts,
        lastAttemptTimestamp: Date.now()
      };
    });
    this.saveState();
    this.checkServerTime(); // Refresh lock status
  }

  addReward(coins: number, gems: number) {
    this._state.update(s => ({
      ...s,
      coins: s.coins + coins,
      gems: s.gems + gems
    }));
    this.saveState();
  }

  resetRewards() {
    this._state.update(s => ({
      ...s,
      coins: 0,
      gems: 0
    }));
    this.saveState();
  }

  getCheckoutPermalink(variantId: string, discountCode: string) {
    // The seamless AJAX cart bypass format requested
    return `/checkout?discount=${discountCode}`;
  }
}

'use client';
import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';

export interface CartItem {
  sku: string;
  name: string;
  name_ar: string | null;
  price: number; // integer piastres
  qty: number;
}

interface CartCtx {
  items: CartItem[];
  addItem: (item: Omit<CartItem, 'qty'>) => void;
  setQty: (sku: string, qty: number) => void;
  clear: () => void;
  total: number;    // integer piastres
  itemCount: number;
}

const CartContext = createContext<CartCtx>({
  items: [],
  addItem: () => {},
  setQty: () => {},
  clear: () => {},
  total: 0,
  itemCount: 0,
});

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);

  function addItem(item: Omit<CartItem, 'qty'>) {
    setItems(prev => {
      const found = prev.find(i => i.sku === item.sku);
      if (found) return prev.map(i => i.sku === item.sku ? { ...i, qty: i.qty + 1 } : i);
      return [...prev, { ...item, qty: 1 }];
    });
  }

  function setQty(sku: string, qty: number) {
    if (qty <= 0) {
      setItems(prev => prev.filter(i => i.sku !== sku));
    } else {
      setItems(prev => prev.map(i => i.sku === sku ? { ...i, qty } : i));
    }
  }

  const total = useMemo(() => items.reduce((s, i) => s + i.price * i.qty, 0), [items]);
  const itemCount = useMemo(() => items.reduce((s, i) => s + i.qty, 0), [items]);

  return (
    <CartContext.Provider value={{ items, addItem, setQty, clear: () => setItems([]), total, itemCount }}>
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);

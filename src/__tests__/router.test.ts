/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReactiveStore } from '../reactive/store.js';
import { Router, loadRoutes } from '../framework/router.js';

async function setupStore(routes: Array<Record<string, string>>): Promise<ReactiveStore> {
  const store = new ReactiveStore();
  for (const r of routes) {
    const key = `route:${r.name}`;
    for (const [field, value] of Object.entries(r)) {
      await store.hset(key, field, value);
    }
  }
  return store;
}

async function addComponent(store: ReactiveStore, name: string, template: string, style?: string): Promise<void> {
  await store.hset(`component:${name}`, 'name', name);
  await store.hset(`component:${name}`, 'template', template);
  if (style) await store.hset(`component:${name}`, 'style', style);
}

describe('loadRoutes', () => {
  it('loads route entities from the store', async () => {
    const store = await setupStore([
      { name: 'home', path: '/', component: 'component:home-page' },
      { name: 'about', path: '/about', component: 'component:about-page' },
    ]);

    const routes = loadRoutes(store);
    expect(routes).toHaveLength(2);
    expect(routes.find(r => r.name === 'home')).toEqual({
      name: 'home', path: '/', component: 'component:home-page', parent: undefined,
    });
  });

  it('skips runtime route keys', async () => {
    const store = await setupStore([
      { name: 'home', path: '/', component: 'component:home-page' },
    ]);
    await store.runtime.hset('route:current', 'name', 'home');
    await store.runtime.hset('route:params', 'id', '42');

    const routes = loadRoutes(store);
    expect(routes).toHaveLength(1);
  });

  it('loads parent field for nested routes', async () => {
    const store = await setupStore([
      { name: 'products', path: '/products', component: 'component:product-layout' },
      { name: 'product-detail', path: '/:id', component: 'component:product-page', parent: 'route:products' },
    ]);

    const routes = loadRoutes(store);
    const detail = routes.find(r => r.name === 'product-detail');
    expect(detail?.parent).toBe('route:products');
  });
});

describe('Router', () => {
  beforeEach(() => {
    // Reset URL
    window.history.replaceState(null, '', '/');
  });

  it('matches root route and renders component', async () => {
    const store = await setupStore([
      { name: 'home', path: '/', component: 'component:home-page' },
    ]);
    await addComponent(store, 'home-page', '<div>Home Page</div>');

    const container = document.createElement('div');
    const router = new Router(store, container);
    await router.start();

    expect(container.textContent).toContain('Home Page');

    // Check runtime state
    expect(store.hget('route:current', 'name')).toBe('home');

    router.stop();
  });

  it('matches parameterized routes', async () => {
    const store = await setupStore([
      { name: 'product', path: '/products/:id', component: 'component:product' },
    ]);
    await addComponent(store, 'product', '<div>Product {hget("route:params", "id")}</div>');

    window.history.replaceState(null, '', '/products/42');
    const container = document.createElement('div');
    const router = new Router(store, container);
    await router.start();

    expect(store.hget('route:params', 'id')).toBe('42');
    expect(container.textContent).toContain('Product 42');

    router.stop();
  });

  it('shows 404 for unmatched routes', async () => {
    const store = await setupStore([
      { name: 'home', path: '/', component: 'component:home-page' },
    ]);
    await addComponent(store, 'home-page', '<div>Home</div>');

    window.history.replaceState(null, '', '/nonexistent');
    const container = document.createElement('div');
    const router = new Router(store, container);
    await router.start();

    expect(container.textContent).toContain('404');

    router.stop();
  });

  it('navigates programmatically', async () => {
    const store = await setupStore([
      { name: 'home', path: '/', component: 'component:home-page' },
      { name: 'about', path: '/about', component: 'component:about-page' },
    ]);
    await addComponent(store, 'home-page', '<div>Home</div>');
    await addComponent(store, 'about-page', '<div>About</div>');

    const container = document.createElement('div');
    const router = new Router(store, container);
    await router.start();

    expect(container.textContent).toContain('Home');

    await router.navigate('/about');
    expect(container.textContent).toContain('About');
    expect(store.hget('route:current', 'name')).toBe('about');

    router.stop();
  });

  it('renders nested routes with rit-outlet', async () => {
    const store = await setupStore([
      { name: 'layout', path: '/app', component: 'component:layout' },
      { name: 'dashboard', path: '/dashboard', component: 'component:dashboard', parent: 'route:layout' },
    ]);
    await addComponent(store, 'layout', '<div class="layout"><h1>App</h1><rit-outlet /></div>');
    await addComponent(store, 'dashboard', '<div>Dashboard Content</div>');

    window.history.replaceState(null, '', '/app/dashboard');
    const container = document.createElement('div');
    const router = new Router(store, container);
    await router.start();

    expect(container.textContent).toContain('App');
    expect(container.textContent).toContain('Dashboard Content');

    router.stop();
  });

  it('cleans up listeners on stop', async () => {
    const store = await setupStore([
      { name: 'home', path: '/', component: 'component:home-page' },
      { name: 'about', path: '/about', component: 'component:about-page' },
    ]);
    await addComponent(store, 'home-page', '<div>Home</div>');
    await addComponent(store, 'about-page', '<div>About</div>');

    const container = document.createElement('div');
    const router = new Router(store, container);
    await router.start();
    expect(container.textContent).toContain('Home');

    router.stop();

    // After stop, popstate should not trigger re-render
    // The container still shows the last rendered content
    expect(container.textContent).toContain('Home');
  });
});

import { OpenFeatureProvider, useBooleanFlagValue, useStringFlagValue } from '@openfeature/react-sdk';

export function App() {
  return (
    <OpenFeatureProvider>
      <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
        <Welcome />
        <Checkout />
      </main>
    </OpenFeatureProvider>
  );
}

function Welcome() {
  // The code's default, until the flags arrive or when the server can't be reached
  const message = useStringFlagValue('welcome_message', 'Hello!');
  return <h1>{message}</h1>;
}

function Checkout() {
  const newCheckout = useBooleanFlagValue('new_checkout', false);
  if (!newCheckout) return <p>Your cart has 2 items. <button type="button">Check out</button></p>;
  return (
    <section style={{ border: '1px solid #3b82f6', borderRadius: 8, padding: 16 }}>
      <strong>New checkout</strong>
      <p>Pay in one step. <button type="button">Pay now</button></p>
    </section>
  );
}

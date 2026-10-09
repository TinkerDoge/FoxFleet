import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './app';
import { applyPrefs } from './state';
import { UpdateBanner } from './components/UpdateBanner';

applyPrefs();
render(<><App /><UpdateBanner /></>, document.getElementById('app')!);

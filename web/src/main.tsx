import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './app';
import { applyPrefs } from './state';

applyPrefs();
render(<App />, document.getElementById('app')!);

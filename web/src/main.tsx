import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import './styles/polish.css';
import './styles/scroll.css';
import './styles/chatbg.css';
import { App } from './app';
import { applyPrefs } from './state';
import { UpdateBanner } from './components/UpdateBanner';

applyPrefs();
render(<><App /><UpdateBanner /></>, document.getElementById('app')!);

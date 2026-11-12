import { Logo } from './components/logo';
import { ButtonLink } from './components/motion/button';
import { ThemeToggle } from './components/motion/theme-toggle';
import { LegalLinks } from './legal/LegalLinks';

const Arrow = () => <span aria-hidden="true">↗</span>;

export function App() {
  return (
    <>
      <a className="skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="header wrap">
        <a className="brand" href="#inicio" aria-label="Soprei, início">
          <Logo alt="Soprei" />
        </a>
        <nav aria-label="Navegação principal">
          <a href="/entrar">Entrar</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#possibilidades">O que é possível</a>
        </nav>
        <div className="header-actions">
          <ThemeToggle />
          <ButtonLink
            href="/entrar"
            variant="outline"
            size="lg"
            className="gap-4 font-bold max-sm:h-10 max-sm:px-4 max-sm:text-xs"
          >
            Entrar no Soprei <Arrow />
          </ButtonLink>
        </div>
      </header>
      <main id="conteudo">
        <section className="hero wrap" id="inicio">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="dot" /> INTELIGÊNCIA PARA CONVERSAR
            </div>
            <h1>
              Uma conversa
              <br />
              <em>muda tudo.</em>
            </h1>
            <p>
              O Soprei une inteligência artificial e WhatsApp para que cada conversa receba a
              atenção que merece.
            </p>
            <ButtonLink
              href="#como-funciona"
              size="lg"
              className="hero-cta gap-8 rounded-xl font-bold"
            >
              Descubra como funciona <Arrow />
            </ButtonLink>
            <div className="hero-note">
              <span>✳</span> Tecnologia para estar mais perto.
            </div>
          </div>
          <div className="visual" aria-label="Exemplo ilustrativo de uma conversa no WhatsApp">
            <div className="visual-orbit orbit-one" />
            <div className="visual-orbit orbit-two" />
            <div className="visual-label">
              <span className="spark">✳</span> MAIS DO QUE RESPOSTAS
              <br />
              <strong>Conversas que fluem.</strong>
            </div>
            <div className="conversation">
              <div className="conversation-head">
                <div className="avatar">
                  <img src="/logo-icon.svg" alt="" />
                </div>
                <div>
                  <strong>Soprei</strong>
                  <small>
                    <i /> Atendimento inteligente
                  </small>
                </div>
                <span className="dots">•••</span>
              </div>
              <div className="conversation-body">
                <div className="date">EXEMPLO ILUSTRATIVO</div>
                <div className="bubble incoming">
                  Olá! Gostaria de saber mais sobre o serviço. <small>10:24</small>
                </div>
                <div className="bubble outgoing">
                  Olá! Que bom ter você por aqui. Como posso ajudar?{' '}
                  <small>
                    10:24 <b>✓✓</b>
                  </small>
                </div>
                <div className="typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="conversation-footer">
                Uma conversa de cada vez <span>✧</span>
              </div>
            </div>
            <div className="floating-card">
              <span className="floating-icon">✦</span>
              <div>
                <strong>Feito para conversar</strong>
                <small>Uma resposta com contexto</small>
              </div>
            </div>
            <div className="visual-caption">01 / UMA NOVA FORMA DE ATENDER</div>
          </div>
        </section>
        <div className="ticker">
          <div className="wrap ticker-inner">
            <span>ATENDIMENTO COM IA</span>
            <i>✳</i>
            <span>CONVERSAS COM CONTEXTO</span>
            <i>✳</i>
            <span>WHATSAPP</span>
            <i>✳</i>
            <span>MAIS PROXIMIDADE</span>
          </div>
        </div>
        <section className="intro wrap" id="como-funciona">
          <div className="section-kicker">
            <span>01 / COMO FUNCIONA</span>
            <span>↓</span>
          </div>
          <div className="intro-grid">
            <h2>
              A tecnologia entra.
              <br />
              <em>A conversa continua.</em>
            </h2>
            <div>
              <p>
                O Soprei recebe mensagens pelo WhatsApp e usa inteligência artificial para responder
                com o contexto da conversa.
              </p>
              <a className="text-link" href="#possibilidades">
                Explore as possibilidades <span>↘</span>
              </a>
            </div>
          </div>
          <div className="steps">
            <article>
              <span className="step-num">01</span>
              <div className="step-icon">↗</div>
              <h3>Uma mensagem chega</h3>
              <p>O contato inicia uma conversa pelo WhatsApp.</p>
            </article>
            <article>
              <span className="step-num">02</span>
              <div className="step-icon">✳</div>
              <h3>O Soprei entende o contexto</h3>
              <p>
                A inteligência artificial considera o histórico da conversa para formular a
                resposta.
              </p>
            </article>
            <article>
              <span className="step-num">03</span>
              <div className="step-icon">↝</div>
              <h3>A conversa segue</h3>
              <p>A resposta é enviada pelo mesmo canal, de forma natural.</p>
            </article>
          </div>
        </section>
        <section className="possibilities" id="possibilidades">
          <div className="wrap">
            <div className="section-kicker">
              <span>02 / FEITO PARA O ATENDIMENTO</span>
              <span>✳</span>
            </div>
            <div className="possibilities-grid">
              <div>
                <h2>
                  Mais espaço para
                  <br />
                  <em>o que importa.</em>
                </h2>
                <p>
                  Uma forma de aproximar sua empresa das pessoas, com a inteligência como aliada em
                  cada conversa.
                </p>
              </div>
              <div className="feature-list">
                <article>
                  <span>01</span>
                  <div>
                    <h3>Um canal que já faz parte do dia</h3>
                    <p>As conversas acontecem no WhatsApp, onde seus contatos já estão.</p>
                  </div>
                  <span>↗</span>
                </article>
                <article>
                  <span>02</span>
                  <div>
                    <h3>Respostas com contexto</h3>
                    <p>O histórico ajuda a dar continuidade ao atendimento.</p>
                  </div>
                  <span>↗</span>
                </article>
                <article>
                  <span>03</span>
                  <div>
                    <h3>Uma voz para sua empresa</h3>
                    <p>O atendimento pode seguir a persona configurada para seu negócio.</p>
                  </div>
                  <span>↗</span>
                </article>
              </div>
            </div>
          </div>
        </section>
        <section className="closing wrap">
          <span className="closing-star">✳</span>
          <p>BOAS CONVERSAS COMEÇAM AQUI</p>
          <h2>
            Vamos mais <em>perto.</em>
          </h2>
          <ButtonLink href="#inicio" size="lg" className="mt-8 gap-8 rounded-xl font-bold">
            Voltar ao início <span>↑</span>
          </ButtonLink>
        </section>
      </main>
      <footer className="footer wrap">
        <Logo alt="Soprei" />
        <span>Inteligência para conversas que importam.</span>
        <LegalLinks className="footer-legal" />
        <a href="#inicio">Voltar ao topo ↑</a>
      </footer>
    </>
  );
}

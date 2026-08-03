import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Optional, Output } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, ToastController } from '@ionic/angular';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MensajeriaService, ChatContacto } from '../../services/mensajeria.service';
import { AuthService } from '../../services/auth.service';
import { abrirWhatsApp } from '../whatsapp.util';

// Hilo de conversación 1:1 (o feed de Avisos del taller con modo="avisos").
// Burbujas, separadores por día, acuse ✓/✓✓, foto y chip de orden. Lo usan los 3 roles.
@Component({
  standalone: false,
  selector: 'app-chat-hilo',
  templateUrl: './chat-hilo.component.html',
  styleUrls: ['./chat-hilo.component.scss'],
})
export class ChatHiloComponent implements OnInit, OnChanges, OnDestroy {
  private destroy$ = new Subject<void>();
  @Input() contacto: ChatContacto | null = null;
  @Input() modo: 'dm' | 'avisos' = 'dm';
  @Output() volver = new EventEmitter<void>();

  mensajes: any[] = [];
  cargando = true;
  // Fotos ya descargadas, por id de mensaje. Un mensaje enviado no cambia nunca, así
  // que una vez traída la imagen no se vuelve a pedir: el refresco de cada 12 s solo
  // busca las de los mensajes nuevos, que normalmente son cero.
  private fotos = new Map<number, string>();
  texto = '';
  enviando = false;
  fotoPreview: string | null = null;
  mostrarRapidas = false;
  miId = this.auth.getUsuario()?.id;
  miRol = this.auth.getUsuario()?.rol;

  readonly rolLabel: Record<string, string> = {
    tecnico: 'Mecánico', recepcion: 'Recepción', admin: 'Dueño / Admin',
  };
  readonly respuestasRapidas = [
    'Listo para entregar',
    'Necesito repuesto',
    'Esperando aprobación del cliente',
    'Moto lista para prueba',
    'Necesito ayuda con esta moto',
  ];

  constructor(
    private msj: MensajeriaService,
    private auth: AuthService,
    private router: Router,
    private toast: ToastController,
    @Optional() private content: IonContent,
  ) {}

  ngOnInit() {
    this.cargar();
    interval(12000).pipe(takeUntil(this.destroy$)).subscribe(() => this.refrescar());
  }
  ngOnChanges() { if (this.mensajes.length) this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  get esAvisos(): boolean { return this.modo === 'avisos'; }
  // En Avisos solo escribe la oficina; el mecánico lo lee.
  get puedeEscribir(): boolean { return !this.esAvisos || this.miRol === 'admin' || this.miRol === 'recepcion'; }
  get esTecnico(): boolean { return this.miRol === 'tecnico'; }

  cargar() {
    this.cargando = true;
    const src$ = this.esAvisos ? this.msj.getAvisos() : this.msj.getConversacion(this.contacto!.id);
    src$.pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => {
        this.mensajes = r.data || [];
        this.cargando = false;
        this.pedirFotosNuevas();
        this.scrollAbajo();
      },
      error: () => { this.cargando = false; },
    });
  }

  private refrescar() {
    const src$ = this.esAvisos ? this.msj.getAvisos() : this.msj.getConversacion(this.contacto!.id);
    src$.pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => {
        const tenia = this.mensajes.length;
        this.mensajes = r.data || [];
        this.pedirFotosNuevas();
        if (this.mensajes.length > tenia) this.scrollAbajo();
      },
    });
  }

  // Descarga solo las fotos que todavía no están en memoria. En un refresco normal
  // no pide ninguna: por eso el polling pasó de mover megabytes a mover texto.
  private pedirFotosNuevas() {
    for (const m of this.mensajes) {
      if (!m.tiene_foto || this.fotos.has(m.id)) continue;
      // Se reserva el lugar antes de pedir: si el refresco vuelve a pasar mientras
      // la petición está en vuelo, no se dispara una segunda igual.
      this.fotos.set(m.id, '');
      this.msj.getFotoMensaje(m.id).pipe(takeUntil(this.destroy$)).subscribe({
        next: r => { this.fotos.set(m.id, r.data); this.scrollAbajo(); },
        error: () => { this.fotos.delete(m.id); },   // se reintenta en el próximo refresco
      });
    }
  }

  // La foto para pintar en la burbuja: '' mientras viaja, null si el mensaje no tiene.
  fotoDe(m: any): string | null {
    return m?.tiene_foto ? (this.fotos.get(m.id) || null) : null;
  }

  // Avatar del contacto en la cabecera. La caché vive en el servicio, compartida con
  // la lista de contactos: es la misma persona y el mismo avatar.
  avatarContacto(): string | null {
    return this.contacto?.tiene_foto ? this.msj.avatar(this.contacto.id) : null;
  }

  enviar(textoOverride?: string) {
    const txt = (textoOverride || this.texto).trim();
    const foto = this.fotoPreview;
    if ((!txt && !foto) || this.enviando) return;
    this.enviando = true;
    this.mostrarRapidas = false;
    const req$ = this.esAvisos ? this.msj.enviarAviso(txt, foto) : this.msj.enviar(this.contacto!.id, txt, foto);
    req$.pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        // La imagen que acabo de mandar ya está acá: se siembra en la caché en vez de
        // volver a bajarla del servidor, así aparece al instante y sin tráfico extra.
        if (foto && r.data?.id) this.fotos.set(r.data.id, foto);
        this.mensajes.push(r.data);
        this.texto = '';
        this.fotoPreview = null;
        this.enviando = false;
        this.scrollAbajo();
      },
      error: async () => {
        this.enviando = false;
        const t = await this.toast.create({ message: 'No se pudo enviar', duration: 1800, color: 'danger' });
        await t.present();
      },
    });
  }

  adjuntarFoto() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        this.toast.create({ message: 'La imagen es muy grande (máx 4 MB)', duration: 2000, color: 'warning' }).then(t => t.present());
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { this.fotoPreview = reader.result as string; };
      reader.readAsDataURL(file);
    };
    input.click();
  }
  quitarFoto() { this.fotoPreview = null; }

  esMio(m: any): boolean { return m.remitente_id === this.miId; }
  abrirOrden(id: number) { if (id) this.router.navigate(['/detalle-orden', id]); }
  whatsapp() { if (this.contacto?.telefono) abrirWhatsApp(this.contacto.telefono, ''); }

  iniciales(nombre?: string): string {
    const p = (nombre || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase();
  }

  private scrollAbajo() { setTimeout(() => this.content?.scrollToBottom(150), 80); }

  mostrarSeparador(i: number): boolean {
    if (i === 0) return true;
    return (this.mensajes[i].created_at || '').slice(0, 10) !== (this.mensajes[i - 1].created_at || '').slice(0, 10);
  }

  etiquetaDia(fecha: string): string {
    if (!fecha) return '';
    const hoy = new Date().toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d = fecha.slice(0, 10);
    if (d === hoy) return 'Hoy';
    if (d === ayer) return 'Ayer';
    return new Date(fecha).toLocaleDateString('es-CR', { day: 'numeric', month: 'short' });
  }

  horaExacta(fecha: string): string {
    if (!fecha) return '';
    return new Date(fecha).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
}

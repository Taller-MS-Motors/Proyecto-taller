import { Component } from '@angular/core';
import { ChatContacto } from '../../services/mensajeria.service';

// Mensajes del mecánico: lista de contactos (todo el personal) + hilo 1:1.
// La lógica vive en los componentes compartidos app-chat-contactos / app-chat-hilo.
@Component({
  standalone: false,
  selector: 'app-mecanico-contacto',
  templateUrl: './mecanico-contacto.page.html',
  styleUrls: ['./mecanico-contacto.page.scss'],
})
export class MecanicoContactoPage {
  chatAbierto: ChatContacto | null = null;
  verAvisos = false;

  abrirChat(c: ChatContacto) { this.chatAbierto = c; this.verAvisos = false; }
  cerrar() { this.chatAbierto = null; this.verAvisos = false; }
}

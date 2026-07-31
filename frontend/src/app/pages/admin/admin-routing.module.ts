import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminShellPage } from './admin-shell.page';
import { AdminResumenPage } from './admin-resumen.page';
import { AdminCitasPage } from './admin-citas.page';
import { AdminEmpleadosPage } from './admin-empleados.page';
import { AdminTareasPage } from './admin-tareas.page';
import { AdminReportesPage } from './admin-reportes.page';
import { AdminOpinionesPage } from './admin-opiniones.page';
import { AdminPromosPage } from './admin-promos.page';
import { AdminCalendarioPage } from './admin-calendario.page';
import { AdminConfigPage } from './admin-config.page';
import { AdminServiciosPage } from './admin-servicios.page';
import { AdminMensajesPage } from './admin-mensajes.page';
import { AdminPerfilPage } from './admin-perfil.page';

const routes: Routes = [
  {
    path: '',
    component: AdminShellPage,
    children: [
      { path: '', redirectTo: 'resumen', pathMatch: 'full' },
      { path: 'resumen', component: AdminResumenPage },
      { path: 'citas', component: AdminCitasPage },
      { path: 'empleados', component: AdminEmpleadosPage },
      { path: 'tareas', component: AdminTareasPage },
      { path: 'mensajes', component: AdminMensajesPage },
      { path: 'reportes', component: AdminReportesPage },
      { path: 'opiniones', component: AdminOpinionesPage },
      { path: 'promos', component: AdminPromosPage },
      { path: 'calendario', component: AdminCalendarioPage },
      { path: 'servicios', component: AdminServiciosPage },
      { path: 'config', component: AdminConfigPage },
      { path: 'perfil', component: AdminPerfilPage },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class AdminPageRoutingModule {}

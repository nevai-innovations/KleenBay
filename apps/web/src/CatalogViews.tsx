import { useEffect, useState, type FormEvent } from 'react';
import { vehicleTypes } from '@carwash/shared';
import { api, patch, post, type Branch, type Customer, type InvoiceListRow, type Job, type Service, type Vehicle } from './api';

const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
const typeName = (type: string) => type.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());

export function CustomersView() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [plate, setPlate] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [vehicleType, setVehicleType] = useState<(typeof vehicleTypes)[number]>('HATCHBACK');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api<Customer[]>(`/customers?q=${encodeURIComponent(query)}`).then(setCustomers).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load customers'));
    }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function openCustomer(id: string) { const [customer, history] = await Promise.all([api<Customer>(`/customers/${id}`), api<InvoiceListRow[]>(`/invoices?customerId=${encodeURIComponent(id)}`)]); setSelected(customer); setInvoices(history); }
  async function createCustomer(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const customer = await post<Customer>('/customers', { name, mobile });
      setName(''); setMobile(''); setQuery('');
      setCustomers(await api<Customer[]>('/customers'));
      await openCustomer(customer.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save customer'); }
    finally { setBusy(false); }
  }
  async function createVehicle(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError('');
    try {
      await post('/vehicles', { customerId: selected.id, registrationNumber: plate, make, model, type: vehicleType });
      setPlate(''); setMake(''); setModel(''); await openCustomer(selected.id);
      setCustomers(await api<Customer[]>('/customers'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save vehicle'); }
    finally { setBusy(false); }
  }

  return <div className="catalog-view"><div className="section-head"><div><h2>Customers & vehicles</h2><p>Find a customer by name, mobile or registration number.</p></div><span className="count-chip">{customers.length} shown</span></div>
    <div className="catalog-grid"><section className="panel catalog-list"><label className="field"><span>Search customers</span><input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, mobile or vehicle number" /></label>
      <div className="catalog-rows">{customers.length ? customers.map((customer) => <button type="button" key={customer.id} className={`catalog-row${selected?.id === customer.id ? ' selected' : ''}`} onClick={() => void openCustomer(customer.id)}><span className="who-dot">{customer.name.slice(0, 1)}</span><span><strong>{customer.name}</strong><small>{customer.mobile} · {customer.vehicles.length} vehicle{customer.vehicles.length === 1 ? '' : 's'}</small></span></button>) : <p className="catalog-empty">No customers found.</p>}</div></section>
      <form className="panel add-form" onSubmit={createCustomer}><h3>Add Customer</h3><label className="field"><span>Name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} required /></label><label className="field"><span>Mobile number</span><input className="input" type="tel" inputMode="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} required /></label><button className="btn primary block" disabled={busy}>Save customer</button></form></div>
    {selected && <section className="panel customer-detail"><div className="detail-head"><div><h3>{selected.name}</h3><p>{selected.mobile}</p></div><span className="count-chip dark">{selected.vehicles.length} vehicle{selected.vehicles.length === 1 ? '' : 's'}</span></div>
      <div className="vehicle-list">{selected.vehicles.length ? selected.vehicles.map((vehicle) => <div className="vehicle-row" key={vehicle.id}><strong>{vehicle.registrationNumber}</strong><span>{vehicle.make} {vehicle.model}</span><small>{typeName(vehicle.type)}</small></div>) : <p className="catalog-empty">No vehicles recorded yet.</p>}</div>
      <h4>Invoice history</h4><div className="vehicle-list">{invoices.length ? invoices.map((invoice) => <a className="vehicle-row" href={`/invoices/${invoice.id}`} key={invoice.id}><strong>{invoice.invoiceNumber}</strong><span>{money(invoice.totalPaise)} · Paid {money(invoice.paidPaise)} · Due {money(invoice.outstandingPaise)}</span><small>{invoice.status.replaceAll('_', ' ')}</small></a>) : <p className="catalog-empty">No invoices yet.</p>}</div>
      <form className="vehicle-form" onSubmit={createVehicle}><h4>Add Vehicle</h4><label className="field"><span>Registration number</span><input className="input" value={plate} onChange={(event) => setPlate(event.target.value)} required placeholder="KL07AB1234" /></label><label className="field"><span>Make</span><input className="input" value={make} onChange={(event) => setMake(event.target.value)} required /></label><label className="field"><span>Model</span><input className="input" value={model} onChange={(event) => setModel(event.target.value)} required /></label><label className="field"><span>Type</span><select className="input" value={vehicleType} onChange={(event) => setVehicleType(event.target.value as (typeof vehicleTypes)[number])}>{vehicleTypes.map((type) => <option key={type} value={type}>{typeName(type)}</option>)}</select></label><button className="btn primary" disabled={busy}>Add vehicle</button></form></section>}
    {error && <div className="portal-error" role="alert">{error}</div>}
  </div>;
}

export function VehiclesView() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api<Vehicle[]>(`/vehicles?q=${encodeURIComponent(query)}`).then(setVehicles).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load vehicles'));
    }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function openVehicle(vehicle: Vehicle) {
    setSelected(vehicle); setError('');
    try {
      const id = encodeURIComponent(vehicle.id);
      const [active, history, bills] = await Promise.all([api<Job[]>(`/jobs?view=active&vehicleId=${id}`), api<Job[]>(`/jobs?view=history&vehicleId=${id}`), api<InvoiceListRow[]>(`/invoices?vehicleId=${id}`)]);
      setJobs([...active, ...history]);
      setInvoices(bills);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load vehicle history'); }
  }

  return <div className="catalog-view"><div className="section-head"><div><h2>Vehicles</h2></div><span className="count-chip">{vehicles.length} shown</span></div>
    <div className="catalog-grid"><section className="panel catalog-list"><label className="field"><span>Search vehicles</span><input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Registration, customer or mobile" /></label>
      <div className="catalog-rows">{vehicles.length ? vehicles.map((vehicle) => <button type="button" key={vehicle.id} className={`catalog-row${selected?.id === vehicle.id ? ' selected' : ''}`} onClick={() => void openVehicle(vehicle)}><span className="who-dot">{vehicle.registrationNumber.slice(0, 1)}</span><span><strong>{vehicle.registrationNumber}</strong><small>{vehicle.make} {vehicle.model} · {vehicle.customer?.name}</small></span></button>) : <p className="catalog-empty">No vehicles found.</p>}</div></section>
      <section className="panel customer-detail"><h3>{selected ? selected.registrationNumber : 'Vehicle history'}</h3>{selected ? <><p>{selected.make} {selected.model} · {selected.customer?.name} · {selected.customer?.mobile}</p><div className="vehicle-list">{jobs.length ? jobs.map((job) => <div className="vehicle-row" key={job.id}><strong>{job.serviceName}</strong><span>{job.status.replaceAll('_', ' ')}</span><small>{new Date(job.checkedInAt).toLocaleDateString('en-IN')}</small></div>) : <p className="catalog-empty">No visits recorded yet.</p>}</div><h4>Invoices</h4><div className="vehicle-list">{invoices.length ? invoices.map((invoice) => <a className="vehicle-row" href={`/invoices/${invoice.id}`} key={invoice.id}><strong>{invoice.invoiceNumber}</strong><span>{money(invoice.totalPaise)} · Paid {money(invoice.paidPaise)} · Due {money(invoice.outstandingPaise)}</span><small>{invoice.status.replaceAll('_', ' ')}</small></a>) : <p className="catalog-empty">No invoices yet.</p>}</div></> : <p className="catalog-empty">Select a vehicle to see its visits.</p>}</section></div>
    {error && <div className="portal-error" role="alert">{error}</div>}
  </div>;
}

export function ServicesView() {
  const [services, setServices] = useState<Service[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('Wash');
  const [newPrice, setNewPrice] = useState('');
  const [newMinutes, setNewMinutes] = useState('');
  const [priceType, setPriceType] = useState<(typeof vehicleTypes)[number]>('HATCHBACK');
  const [priceBranch, setPriceBranch] = useState('');
  const [overridePrice, setOverridePrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = services.find((service) => service.id === selectedId);

  async function refresh() { setServices(await api<Service[]>('/services')); }
  useEffect(() => {
    void Promise.all([api<Service[]>('/services'), api<Branch[]>('/branches')])
      .then(([serviceList, locationList]) => { setServices(serviceList); setBranches(locationList); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load services'));
  }, []);

  async function createService(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const created = await post<Service>('/services', { name: newName, category: newCategory, basePricePaise: Math.round(Number(newPrice) * 100), estimatedMinutes: Number(newMinutes) });
      setNewName(''); setNewPrice(''); setNewMinutes(''); await refresh(); setSelectedId(created.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save service'); }
    finally { setBusy(false); }
  }
  async function toggleActive(service: Service) {
    setError('');
    try { await patch(`/services/${service.id}`, { active: !service.active }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update service'); }
  }
  async function setBranchAvailability(service: Service, branchId: string, active: boolean) {
    setError('');
    try { await api(`/services/${service.id}/branches/${branchId}`, { method: 'PUT', body: JSON.stringify({ active }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update branch availability'); }
  }
  async function savePrice(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError('');
    try {
      await api(`/services/${selected.id}/prices`, { method: 'PUT', body: JSON.stringify({ vehicleType: priceType, pricePaise: Math.round(Number(overridePrice) * 100), ...(priceBranch ? { branchId: priceBranch } : {}) }) });
      setOverridePrice(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save price'); }
    finally { setBusy(false); }
  }

  return <div className="catalog-view"><div className="section-head"><div><h2>Wash services</h2><p>Configure services and vehicle-based prices.</p></div><span className="count-chip">{services.filter((service) => service.active).length} active</span></div>
    <div className="catalog-grid"><section className="panel catalog-list"><div className="team-list-head"><strong>Services</strong><span>{services.length}</span></div><div className="catalog-rows">{services.length ? services.map((service) => <button type="button" key={service.id} className={`catalog-row${selectedId === service.id ? ' selected' : ''}`} onClick={() => setSelectedId(service.id)}><span><strong>{service.name}</strong><small>{service.category} · {service.estimatedMinutes} min</small></span><span className="service-amount">{money(service.basePricePaise)}</span>{!service.active && <small>Inactive</small>}</button>) : <p className="catalog-empty">No services yet.</p>}</div></section>
      <form className="panel add-form" onSubmit={createService}><h3>Add Service</h3><label className="field"><span>Name</span><input className="input" value={newName} onChange={(event) => setNewName(event.target.value)} required /></label><label className="field"><span>Category</span><input className="input" value={newCategory} onChange={(event) => setNewCategory(event.target.value)} required /></label><label className="field"><span>Base price (₹)</span><input className="input" type="number" min="0" step="0.01" value={newPrice} onChange={(event) => setNewPrice(event.target.value)} required /></label><label className="field"><span>Estimated minutes</span><input className="input" type="number" min="1" value={newMinutes} onChange={(event) => setNewMinutes(event.target.value)} required /></label><button className="btn primary block" disabled={busy}>Add service</button></form></div>
    {selected && <section className="panel service-detail"><div className="detail-head"><div><h3>{selected.name}</h3><p>Base {money(selected.basePricePaise)} · {selected.estimatedMinutes} min</p></div><button className="btn small" onClick={() => void toggleActive(selected)}>{selected.active ? 'Deactivate' : 'Activate'}</button></div>{branches.length > 1 && <div className="service-branches"><strong>Available at</strong>{branches.map((branch) => <label key={branch.id}><input type="checkbox" checked={selected.branches.find((entry) => entry.branchId === branch.id)?.active ?? true} onChange={(event) => void setBranchAvailability(selected, branch.id, event.target.checked)} />{branch.name}</label>)}</div>}<div className="price-list"><strong>Vehicle prices</strong>{selected.prices.length ? selected.prices.map((price) => <div className="price-row" key={price.id}><span>{typeName(price.vehicleType)}{price.branchId ? ` · ${branches.find((branch) => branch.id === price.branchId)?.name || 'Branch'}` : ''}</span><strong>{money(price.pricePaise)}</strong></div>) : <p className="catalog-empty">Base price applies to every vehicle.</p>}</div>
      <form className="price-form" onSubmit={savePrice}><h4>Set Vehicle Price</h4><label className="field"><span>Vehicle type</span><select className="input" value={priceType} onChange={(event) => setPriceType(event.target.value as (typeof vehicleTypes)[number])}>{vehicleTypes.map((type) => <option key={type} value={type}>{typeName(type)}</option>)}</select></label>{branches.length > 1 && <label className="field"><span>Branch</span><select className="input" value={priceBranch} onChange={(event) => setPriceBranch(event.target.value)}><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}<label className="field"><span>Price (₹)</span><input className="input" type="number" min="0" step="0.01" value={overridePrice} onChange={(event) => setOverridePrice(event.target.value)} required /></label><button className="btn primary" disabled={busy}>Save price</button></form></section>}
    {error && <div className="portal-error" role="alert">{error}</div>}
  </div>;
}

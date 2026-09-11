import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/validate-file-ingestion-contract.mjs <contract.json>');
  process.exit(2);
}

const contract = JSON.parse(fs.readFileSync(path, 'utf8'));
const errors = [];
const controls = contract.requiredControls ?? {};
const scanner = contract.malwareScanning ?? {};
const acceptance = contract.acceptance ?? {};

if (contract.scope !== 'controlled-preview') errors.push('scope must remain controlled-preview');
if (!Number.isInteger(contract.maxFileBytes) || contract.maxFileBytes <= 0 || contract.maxFileBytes > 12 * 1024 * 1024) errors.push('maxFileBytes must be a positive value no greater than 12 MiB');
if (!Array.isArray(contract.supportedExtensions) || !contract.supportedExtensions.length) errors.push('supportedExtensions required');
for (const key of ['authenticatedUpload','workspaceOwnershipCheckedBeforeProcessing','projectOwnershipCheckedBeforePersistence','contentHashDuplicateDetection','basicFileSignatureValidation','textExtractionRequired','mediatedObjectStorage','documentAndChunkProvenancePersisted']) {
  if (controls[key] !== true) errors.push(`required control missing: ${key}`);
}
if (scanner.configured !== true) {
  if (scanner.runtimeStatus !== 'SCANNER_NOT_CONFIGURED') errors.push('unconfigured scanner must be reported truthfully');
  if (scanner.mayClaimSecureScannedUpload !== false) errors.push('secure/scanned upload claim forbidden while scanner is unconfigured');
  if (scanner.blocksProductionReadyClaim !== true) errors.push('unconfigured scanner must block production-ready upload claims');
}
if (acceptance.repositoryEvidenceRequired !== true) errors.push('repository evidence must be required');
if (acceptance.liveStorageRoundTripRequiredForRuntimePass !== true) errors.push('live storage round-trip must be required for runtime PASS');
if (acceptance.malwareScannerEvidenceRequiredForSecureUploadClaim !== true) errors.push('scanner evidence must be required for secure upload claim');
if (acceptance.ownerApprovalRequiredForProduction !== true) errors.push('owner approval must be required for production');
if (acceptance.productionApproved !== false) errors.push('productionApproved must remain false in repository contract');

if (errors.length) {
  console.error(`FILE_INGESTION_CONTRACT_FAIL: ${errors.join('; ')}`);
  process.exit(1);
}
console.log('FILE_INGESTION_CONTRACT_PASS');

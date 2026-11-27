@description('UTC end of the approved test. Deploy only into a new, dedicated resource group.')
param expires string

var deleteUri = '${environment().resourceManager}${substring(resourceGroup().id, 1)}?api-version=2022-09-01'
resource expiry 'Microsoft.Logic/workflows@2019-05-01' = {
  name: 'expire-synthetic-test'
  location: resourceGroup().location
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      triggers: { expiry: { type: 'Recurrence', recurrence: { frequency: 'Hour', interval: 1, startTime: expires } } }
      actions: {
        deleteOnlyThisTestGroup: {
          type: 'Http'
          inputs: { method: 'DELETE', uri: deleteUri, authentication: { type: 'ManagedServiceIdentity' } }
          operationOptions: 'DisableAsyncPattern'
          runAfter: {}
        }
      }
    }
  }
}
resource deleteOnly 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'expiry-delete-only')
  properties: {
    roleName: 'Expire isolated test ${uniqueString(resourceGroup().id)}'
    description: 'Delete this disposable resource group at its fixed expiry; no other actions.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: ['Microsoft.Resources/subscriptions/resourceGroups/delete'] }]
  }
}
resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, expiry.name, deleteOnly.name)
  properties: { roleDefinitionId: deleteOnly.id, principalId: expiry.identity.principalId, principalType: 'ServicePrincipal' }
}
